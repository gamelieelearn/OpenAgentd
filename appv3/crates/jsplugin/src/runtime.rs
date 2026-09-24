//! One QuickJS runtime per plugin file, owned by a dedicated OS thread with
//! its own single-threaded tokio runtime. Callers talk to it via a channel;
//! every call runs as its own local task, so a call that is awaiting I/O
//! (an OAuth callback, a token refresh) never blocks the plugin's other calls.

use crate::host::{self, HostState};
use crate::transpile;
use rquickjs::loader::{ImportAttributes, Loader, Resolver};
use rquickjs::{AsyncContext, AsyncRuntime, Ctx, Function, Module, Object, Promise};
use serde_json::{Map, Value};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use tokio::sync::mpsc;

const PRELUDE: &str = include_str!("prelude.js");
const MODULE: &str = include_str!("module.js");
/// Per-plugin heap cap (QuickJS allocations only).
const MEMORY_LIMIT: usize = 512 << 20;
const THREAD_STACK: usize = 16 << 20;
const JS_STACK: usize = 8 << 20;

/// What a call is made on.
#[derive(Debug, Clone)]
pub enum Target {
    /// A module export, by property path (`[]` = the module namespace itself).
    Export(Vec<String>),
    /// An object kept from an earlier `Mode::Keep` call.
    Handle(u64),
}

impl Target {
    pub fn export(path: &str) -> Self {
        Target::Export(if path.is_empty() { vec![] } else { path.split('.').map(String::from).collect() })
    }
    fn json(&self) -> String {
        match self {
            Target::Export(p) => serde_json::json!({"path": p}).to_string(),
            Target::Handle(h) => serde_json::json!({"handle": h}).to_string(),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Return the (JSON-serialised) result.
    Value,
    /// Keep the returned object alive on the JS side and return a handle
    /// plus its method names and JSON-serialisable fields.
    Keep,
    /// Also return the arguments as they are after the call (for hooks that
    /// mutate their arguments in place).
    Args,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Value => "value",
            Mode::Keep => "keep",
            Mode::Args => "args",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct CallResult {
    pub value: Value,
    pub handle: Option<u64>,
    pub methods: Vec<String>,
    pub args: Option<Vec<Value>>,
}

/// An exception thrown (or a promise rejected) by plugin code.
#[derive(Debug, Clone, Default)]
pub struct JsError {
    pub name: String,
    pub message: String,
    pub stack: Option<String>,
    /// Own enumerable properties of the error object (`kind`, `status`, …).
    pub props: Map<String, Value>,
}

impl JsError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { name: "Error".into(), message: message.into(), ..Default::default() }
    }
    pub fn prop_str(&self, key: &str) -> Option<&str> {
        self.props.get(key).and_then(|v| v.as_str())
    }
}

impl std::fmt::Display for JsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for JsError {}

type Reply = Box<dyn FnOnce(Result<CallResult, JsError>) + Send>;

enum Msg {
    Call { target: String, method: String, args: String, mode: Mode, reply: Reply },
    Drop(u64),
}

/// A loaded plugin file.
pub struct JsPlugin {
    pub path: PathBuf,
    /// File name (`my_plugin.ts`).
    pub file_name: String,
    /// File stem (`my_plugin`).
    pub stem: String,
    /// `__oad_describe()`: export names, `provider` fields, plugin factory.
    pub describe: Value,
    tx: mpsc::UnboundedSender<Msg>,
}

impl std::fmt::Debug for JsPlugin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("JsPlugin").field("path", &self.path).finish()
    }
}

impl JsPlugin {
    /// Spawn the plugin's runtime thread and evaluate the module.
    pub fn load(path: &Path) -> Result<Arc<JsPlugin>, String> {
        let path = path.to_path_buf();
        let file_name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let stem = path.file_stem().and_then(|n| n.to_str()).unwrap_or("").to_string();
        let (tx, rx) = mpsc::unbounded_channel();
        let (init_tx, init_rx) = std::sync::mpsc::channel::<Result<Value, String>>();
        let p = path.clone();
        let label = stem.clone();
        std::thread::Builder::new()
            .name(format!("plugin-{stem}"))
            .stack_size(THREAD_STACK)
            .spawn(move || thread_main(p, label, rx, init_tx))
            .map_err(|e| e.to_string())?;
        let describe = init_rx.recv().map_err(|_| "plugin runtime thread exited during load".to_string())??;
        Ok(Arc::new(JsPlugin { path, file_name, stem, describe, tx }))
    }

    fn send(&self, target: &Target, method: &str, args: &[Value], mode: Mode, reply: Reply) {
        let args = serde_json::to_string(args).unwrap_or_else(|_| "[]".into());
        let msg = Msg::Call { target: target.json(), method: method.to_string(), args, mode, reply };
        if let Err(mpsc::error::SendError(Msg::Call { reply, .. })) = self.tx.send(msg) {
            reply(Err(JsError::new("plugin runtime has stopped")));
        }
    }

    /// Call `target[method](...args)`, awaiting a returned promise.
    pub async fn call(&self, target: &Target, method: &str, args: &[Value], mode: Mode) -> Result<CallResult, JsError> {
        let (tx, rx) = tokio::sync::oneshot::channel();
        self.send(
            target,
            method,
            args,
            mode,
            Box::new(move |r| {
                let _ = tx.send(r);
            }),
        );
        rx.await.unwrap_or_else(|_| Err(JsError::new("plugin runtime has stopped")))
    }

    /// Blocking variant of [`call`] for synchronous callers.
    pub fn call_blocking(&self, target: &Target, method: &str, args: &[Value], mode: Mode) -> Result<CallResult, JsError> {
        let (tx, rx) = std::sync::mpsc::channel();
        self.send(
            target,
            method,
            args,
            mode,
            Box::new(move |r| {
                let _ = tx.send(r);
            }),
        );
        rx.recv().unwrap_or_else(|_| Err(JsError::new("plugin runtime has stopped")))
    }

    /// Release an object kept by a `Mode::Keep` call.
    pub fn release(&self, handle: u64) {
        let _ = self.tx.send(Msg::Drop(handle));
    }
}

fn thread_main(path: PathBuf, label: String, rx: mpsc::UnboundedReceiver<Msg>, init_tx: std::sync::mpsc::Sender<Result<Value, String>>) {
    let rt = match tokio::runtime::Builder::new_current_thread().enable_all().build() {
        Ok(rt) => rt,
        Err(e) => {
            let _ = init_tx.send(Err(e.to_string()));
            return;
        }
    };
    let local = tokio::task::LocalSet::new();
    local.block_on(&rt, async move {
        let (qrt, ctx, describe) = match init(&path, &label).await {
            Ok(v) => v,
            Err(e) => {
                let _ = init_tx.send(Err(e));
                return;
            }
        };
        let _ = init_tx.send(Ok(describe));
        // Drives promises/timers that outlive the call that created them.
        tokio::task::spawn_local(qrt.drive());
        let mut rx = rx;
        while let Some(msg) = rx.recv().await {
            let ctx = ctx.clone();
            match msg {
                Msg::Call { target, method, args, mode, reply } => {
                    tokio::task::spawn_local(async move { reply(invoke(&ctx, target, method, args, mode).await) });
                }
                Msg::Drop(id) => {
                    tokio::task::spawn_local(async move {
                        ctx.with(|ctx| {
                            if let Ok(f) = ctx.globals().get::<_, Function>("__oad_drop") {
                                let _ = f.call::<_, ()>((id as f64,));
                            }
                        })
                        .await
                    });
                }
            }
        }
        drop(qrt);
    });
}

/// Turn a caught QuickJS error into a [`JsError`].
fn js_error(ctx: &Ctx<'_>, e: rquickjs::Error) -> JsError {
    if !matches!(e, rquickjs::Error::Exception) {
        return JsError::new(e.to_string());
    }
    let caught = ctx.catch();
    let json: Option<String> = ctx.globals().get::<_, Function>("__oad_error").ok().and_then(|f| f.call::<_, String>((caught.clone(),)).ok());
    let Some(v) = json.and_then(|s| serde_json::from_str::<Value>(&s).ok()) else {
        return JsError::new(format!("{caught:?}"));
    };
    JsError {
        name: v.get("name").and_then(|x| x.as_str()).unwrap_or("Error").to_string(),
        message: v.get("message").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        stack: v.get("stack").and_then(|x| x.as_str()).map(String::from),
        props: v.get("props").and_then(|x| x.as_object()).cloned().unwrap_or_default(),
    }
}

async fn invoke(ctx: &AsyncContext, target: String, method: String, args: String, mode: Mode) -> Result<CallResult, JsError> {
    let out: Result<String, JsError> = ctx.async_with(async |ctx| {
        let r: rquickjs::Result<String> = async {
            let f: Function = ctx.globals().get("__oad_invoke")?;
            let p: Promise = f.call((target, method, args, mode.as_str()))?;
            p.into_future::<String>().await
        }
        .await;
        r.map_err(|e| js_error(&ctx, e))
    })
    .await;
    let v: Value = serde_json::from_str(&out?).map_err(|e| JsError::new(format!("plugin returned a value that is not JSON-serialisable: {e}")))?;
    Ok(CallResult {
        handle: v.get("handle").and_then(|x| x.as_u64()),
        methods: v.get("methods").and_then(|m| m.as_array()).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
        args: v.get("args").and_then(|a| a.as_array()).cloned(),
        value: v.get("value").cloned().unwrap_or(Value::Null),
    })
}

async fn init(path: &Path, label: &str) -> Result<(AsyncRuntime, AsyncContext, Value), String> {
    let rt = AsyncRuntime::new().map_err(|e| e.to_string())?;
    rt.set_memory_limit(MEMORY_LIMIT).await;
    rt.set_max_stack_size(JS_STACK).await;
    rt.set_loader(PluginResolver, PluginLoader).await;
    let who = label.to_string();
    rt.set_host_promise_rejection_tracker(Some(Box::new(move |ctx, _promise, reason, is_handled| {
        if !is_handled {
            let msg = ctx.globals().get::<_, Function>("__oad_error").ok().and_then(|f| f.call::<_, String>((reason,)).ok()).unwrap_or_default();
            tracing::warn!("plugin_unhandled_rejection plugin={} error={}", who, msg);
        }
    })))
    .await;
    let ctx = AsyncContext::full(&rt).await.map_err(|e| e.to_string())?;
    let state = HostState::new(label);
    let spec = path.to_string_lossy().into_owned();
    let describe: Result<String, String> = ctx.async_with(async |ctx| {
        let r: rquickjs::Result<String> = async {
            host::install(&ctx, state)?;
            ctx.eval::<(), _>(PRELUDE)?;
            let ns: Object = Module::import(&ctx, spec)?.into_future::<Object>().await?;
            ctx.globals().set("__oad_ns", ns)?;
            ctx.eval::<String, _>("__oad_describe()")
        }
        .await;
        r.map_err(|e| {
            let je = js_error(&ctx, e);
            match je.name.as_str() {
                "Error" | "" => je.message,
                n => format!("{n}: {}", je.message),
            }
        })
    })
    .await;
    let describe = serde_json::from_str(&describe?).map_err(|e| e.to_string())?;
    Ok((rt, ctx, describe))
}

fn normalize(p: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in p.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

struct PluginResolver;

impl Resolver for PluginResolver {
    fn resolve<'js>(&mut self, _ctx: &Ctx<'js>, base: &str, name: &str, _attrs: Option<ImportAttributes<'js>>) -> rquickjs::Result<String> {
        if name == "openagentd" {
            return Ok(name.into());
        }
        if !(name.starts_with("./") || name.starts_with("../") || name.starts_with('/')) {
            return Err(rquickjs::Error::new_resolving_message(base, name, "only relative imports and \"openagentd\" are supported"));
        }
        let dir = Path::new(base).parent().unwrap_or(Path::new("/"));
        let p = normalize(&dir.join(name));
        let s = p.to_string_lossy();
        let candidates = [p.clone(), PathBuf::from(format!("{s}.ts")), PathBuf::from(format!("{s}.js")), p.join("index.ts"), p.join("index.js")];
        if let Some(c) = candidates.iter().find(|c| c.is_file()) {
            return Ok(c.to_string_lossy().into_owned());
        }
        Err(rquickjs::Error::new_resolving_message(base, name, "file not found"))
    }
}

struct PluginLoader;

impl Loader for PluginLoader {
    fn load<'js>(&mut self, ctx: &Ctx<'js>, name: &str, _attrs: Option<ImportAttributes<'js>>) -> rquickjs::Result<Module<'js, rquickjs::module::Declared>> {
        if name == "openagentd" {
            return Module::declare(ctx.clone(), name, MODULE);
        }
        let src = std::fs::read_to_string(name).map_err(|e| rquickjs::Error::new_loading_message(name, e.to_string()))?;
        let js = transpile::transpile(Path::new(name), &src).map_err(|e| rquickjs::Error::new_loading_message(name, e))?;
        Module::declare(ctx.clone(), name, js)
    }
}
