# Batch scripts

The original command-line pipeline that the userscript grew out of: fetch posts from a set of subreddits, score them with an LLM, and write the worst offenders to a CSV audit log.

| Script | What it does |
|---|---|
| `finalrun.py` | **Deep research pipeline.** LangChain extracts the claim → [GPT-Researcher](https://github.com/assafelovic/gpt-researcher) researches it on the web → LangChain audit (`truth_score`, `sarcasm_score`, `factual_check`, `verdict`) → `final_policy_audit.csv` |
| `run2.py` | Single-prompt scorer with `factual_check` / `context_check` / `verdict_summary` → `policy_truth_audit.csv` |
| `legacy/` | Earlier iterations (superseded, kept for reference) |

```bash
cd batch
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env          # OPENAI_API_KEY, TAVILY_API_KEY (finalrun.py)
python finalrun.py
```

Edit `TARGET_SUBS` at the top of each script to choose the subreddits.
