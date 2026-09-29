# Turbovec Documentation Search Experiment

This proof of concept indexes Markdown under `documents/` with local sentence
transformer embeddings. It is isolated from `app/` and is not part of the
runtime package or release builds.

## Setup and commands

Run from the repository root; `uv run --with` supplies the dependencies:

```bash
uv run --with 'sentence-transformers>=5.6.0' --with 'turbovec>=0.8.0' python experiments/turbovec_docs/build_index.py
uv run --with 'sentence-transformers>=5.6.0' --with 'turbovec>=0.8.0' python experiments/turbovec_docs/search.py "query"
uv run --with 'sentence-transformers>=5.6.0' --with 'turbovec>=0.8.0' python experiments/turbovec_docs/benchmark.py -v
```

- `chunker.py` owns heading-based Markdown chunking and source metadata.
- `build_index.py` rebuilds the vector index and metadata sidecar from scratch.
- `search.py` is the query CLI; `benchmark.py` evaluates the retained test set.
- `index/` is generated and ignored. Change chunking/index sources, then rerun
  `build_index.py`; do not commit local model caches or index output.

Run the benchmark after changing chunking, embedding, indexed documents, or
the retained test set. Report model-download/network limitations when the
optional local embedding model is unavailable.
