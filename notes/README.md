# Notes

Working notes for ContextQuant. The question I'm trying to answer:

> When an agent gets a big JSON list from a tool, does it do better if we cut the result down
> *and tell it exactly what was cut*, compared with sending everything or cutting silently?

| File | What's in it |
|---|---|
| [findings.md](findings.md) | My own measurements, including the ones that failed |
| [problem.md](problem.md) | How clients and servers handle oversized tool results today |
| [literature.md](literature.md) | Papers that bear on the question, and what each one implies here |
| [landscape.md](landscape.md) | Other tools in this space and how they differ |
| [next.md](next.md) | Open questions and the experiments that would answer them |

## How these were put together

`findings.md` comes from runs in this repo (`bench/`, `eval/`, live GitHub calls). Everything else came
from a research pass in late October 2026: arXiv metadata pulled from the export API, vendor docs,
GitHub issues and forum threads. I have not re-read every source myself. Treat numbers from the other
notes as "someone reported this" until checked, and treat 2026 arXiv preprints as unreviewed.

Tags used in the notes:

- **[measured]**: a number from a test, eval or log
- **[doc]**: official vendor documentation
- **[report]**: a user complaint, forum post or blog, one source
- **[preprint]**: arXiv paper, not peer reviewed
