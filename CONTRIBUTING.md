# Contributing to lang-forma

Internal details for contributors. Consumers should see the [README](README.md)
for usage and the public API.

## Development environment

Development happens inside a dev container that provisions the toolchain —
Deno, the GitHub CLI, and Ollama — for you.

1. Open the repository in VS Code and rebuild/reopen it in the dev container
   when prompted.
2. On container start, `.devcontainer/ensure-ollama.sh` runs automatically. It
   starts the Ollama server if it is not already running and pulls the cloud
   models this project uses:
   - `glm-5.3-flash:cloud`
   - `glm-5.3:cloud`

### Why Ollama is included

Ollama exists purely as an **optional development aid**. The
[Ollama extension for VS Code](https://marketplace.visualstudio.com/items?itemName=Ollama.ollama)
(installed by the dev container) makes Ollama models appear in the model picker
of the GitHub Copilot Chat session window, where they can be selected alongside
the usual Copilot models. It is **not a dependency of the project itself** —
nothing in lang-forma builds on it, the test suite does not touch it, and you
can ignore it entirely if you do not want it.

The only mandatory part of working on this project is Deno. If you would rather
not use Ollama, you can simply skip the authentication step below; the dev
container will still work normally.

### Ollama authentication

The cloud models used by this project run on Ollama's servers rather than
locally, so pulling them requires an authenticated
[ollama.com](https://ollama.com) account. Authentication is tied to a private
key stored at `~/.ollama/id_ed25519`, which the dev container persists across
rebuilds in a named Docker volume.

#### First-time setup

The startup script creates an anonymous key automatically, but cloud model
pulls fail until that key is linked to an account. If a rebuild is your first
time in the container (or the volume was created fresh), run:

```sh
ollama signin
```

This prints a URL and a device code. Open the URL in a browser, sign in to
ollama.com (creating an account if needed), and enter the device code.

After signing in, if any models are still missing, either restart the container
or pull them manually:

```sh
ollama pull glm-5.3-flash:cloud
ollama pull glm-5.3:cloud
```

Verify everything is available:

```sh
ollama list
```

Both models should be listed. Once signed in, the key lives in the persisted
volume and no further manual steps are needed — container rebuilds will pull
the models automatically.

#### Troubleshooting

- **Pull failures at container start.** Check the log:
  ```sh
  cat /tmp/ollama-pull.log
  ```
  An authentication error means `ollama signin` has not been completed for the
  current key. Sign in, then pull the missing models by hand.
- **`ollama serve` fails with `permission denied` on `id_ed25519`.** The startup
  script repairs the ownership of `~/.ollama` automatically (the container has
  passwordless sudo). If you hit this outside the script, run:
  ```sh
  sudo chown -R "$(id -u):$(id -g)" ~/.ollama
  ```
- **Server does not come up.** Check the server log:
  ```sh
  cat /tmp/ollama.log
  ```

## Algorithm

The parsing engine is **Parsing with Zippers** (Darragh & Adams, ICFP 2020),
extended here with full semantic-action support.

Instead of computing global Brzozowski derivatives, the engine maintains a
_worklist of zippers_ — each zipper is a `(Exp, Mem, value)` triple where `Exp`
is the in-focus subexpression, `Mem` records the start/end position plus parent
contexts, and `value` carries the accumulated semantic result. One `step(token)`
advances every zipper in the current worklist:

- **Descent** (`Exp.goDown`): if a node has already been visited at the current
  position, the new parent context is threaded into its existing memo and any
  already-completed values are re-flowed — no re-traversal. Otherwise a fresh
  memo is allocated and `descend` dispatches structurally.
- **Ascent** (`Cxt.goUp`): each context type knows how to combine an incoming
  value with its accumulated state and propagate upward:
  - `SeqCxt` collects child values left-to-right, then calls `fn(vals)`.
  - `AltCxt` passes the value straight through to the parent memo.
  - `RedCxt` applies a semantic function before propagating.
  - `TopCxt` appends to the driver's result list.
- **Memos** (`Mem`): shared per `(node, startPos)` pair. `completeAt` records
  the value, sets `endPos`, and fires all registered parent contexts — enabling
  full parse forests on ambiguous grammars.

**Recognition mode**: `recognize()` enables a `recognizeOnly` flag that
suppresses duplicate completions at the same position, giving polynomial `O(n²)`
time on ambiguous grammars (the same asymptote as Earley/CYK) while full
`parse()` still returns the complete forest.

**Token-stream API**: `ZipperDriver` exposes a stepwise interface (`init` /
`step` / `flushEof` / `forest`) — the derivative-as-continuation primitive. The
live driver state _is_ the resumable parse: feed tokens as they arrive, pause
when input is exhausted, resume when more arrives. `withInitialOffset` sets the
base offset so a segment parse of a larger source reports spans in absolute
coordinates.

**Incremental memo reuse**: `stepReplay(token)` reuses the existing `Pos`
sentinel for a token's offset if the driver visited it in a prior pass (via an
`offsetToPos` reverse-lookup), so `Exp.m` memos hit on the unchanged region.
`Grammar.reparseIncremental` feeds the unchanged prefix/suffix via `stepReplay`
and the edited region via `step` (fresh `Pos`), yielding O(affected region)
re-parsing.

### Performance

Empirical scaling on the inherently-ambiguous worst case `S = S+S | 1`
(`recognize` mode; fresh grammar instance per iteration; mean of 5 runs with the
noisiest outlier discarded on small inputs):

| n    | input length | Grammar (PwZ) |
| ---- | ------------ | ------------- |
| 10   | 19           | ~1 ms         |
| 20   | 39           | ~3 ms         |
| 50   | 99           | ~4 ms         |
| 100  | 199          | ~15 ms        |
| 200  | 399          | ~80 ms        |
| 300  | 599          | ~218 ms       |
| 500  | 999          | ~1004 ms      |
| 1000 | 1999         | ~8.5 s        |

Run the benchmark yourself:

```bash
deno task bench
```
