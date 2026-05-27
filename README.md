# reddit-truth-auditor

**AI-powered Reddit post truthfulness scorer using GPT-4o-mini and autonomous research agents.**

Fetches posts from configurable subreddits, runs them through a multi-stage LLM pipeline to evaluate factual accuracy, and saves the worst offenders to a structured CSV audit log.

## Features

- **Multi-stage analysis** — factual check, context check, and verdict summary per post
- **Autonomous deep research** — `finalrun.py` uses [GPT-Researcher](https://github.com/assafelovic/gpt-researcher) to conduct real web research before scoring
- **LangChain pipeline** — structured JSON output via prompt chaining and `JsonOutputParser`
- **Cost tracking** — token usage and USD cost logged per run
- **CSV audit log** — scored posts saved with date, subreddit, score, reasoning, and URL

## Requirements

- Python 3.10+
- OpenAI API key
- (For `finalrun.py`) `TAVILY_API_KEY` for GPT-Researcher web search

## Quick Start

```bash
git clone https://github.com/pjvjay/reddit-truth-auditor
cd reddit-truth-auditor

python -m venv venv
source venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Add your OPENAI_API_KEY (and TAVILY_API_KEY for finalrun.py)

python finalrun.py
```

## Scripts

Three iterations, each more powerful than the last:

### `run.py` — Basic scorer
Fetches posts from a subreddit and scores them 0–10 for truthfulness using a single GPT-4o-mini prompt. Outputs results to `reddit_truth_audit.csv`.

### `run2.py` — Multi-component reasoning
Breaks analysis into three structured components returned as JSON:
- `factual_check` — verifies specific numbers, laws, and claims
- `context_check` — evaluates how the post fits the current policy landscape
- `verdict_summary` — one-sentence conclusion

Targets configurable subreddits (default: Canadian immigration/policy communities).

### `finalrun.py` — Deep research pipeline *(recommended)*
Uses [GPT-Researcher](https://github.com/assafelovic/gpt-researcher) to autonomously research each post's core claim on the web before scoring. Pipeline:

```
Reddit post
    ↓
LangChain: extract verifiable claim + search query
    ↓
GPT-Researcher: autonomous web research (5–10 sources)
    ↓
LangChain: audit claim against research report
    ↓
JSON output: truth_score, sarcasm_score, factual_check, verdict
    ↓
CSV: final_policy_audit.csv
```

## Configuration

Edit the `TARGET_SUBS` list at the top of each script:

```python
TARGET_SUBS = ['lmiascams', 'destiny', 'canadian', 'askcanada', 'vancouverjobs']
```

Environment variables (`.env`):
```
OPENAI_API_KEY=sk-...
TAVILY_API_KEY=tvly-...   # required for finalrun.py
```

## Output

CSV columns (finalrun.py):

| Column | Description |
|---|---|
| `date` | Run date |
| `score` | Truthfulness score 0–10 (lower = less truthful) |
| `subreddit` | Source subreddit |
| `title` | Post title |
| `factual_check` | Specific fact verification from research |
| `context_check` | How claim fits current policy/news context |
| `verdict` | One-sentence final assessment |
| `url` | Direct link to Reddit post |

## Project Structure

```
reddit-truth-auditor/
├── run.py            # Basic GPT scorer
├── run2.py           # Multi-component reasoning scorer
├── finalrun.py       # Full research pipeline (recommended)
├── requirements.txt
├── .env.example
└── *.csv             # Audit output (gitignored)
```
