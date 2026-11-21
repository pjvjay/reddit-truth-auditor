import os
import requests
import json
import csv
import time
from datetime import datetime
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

# --- CONFIG ---
TARGET_SUBS = ['lmiascams', 'destiny', 'canadian', 'tourism', 'askcanada', 'vancouverjobs']
CSV_FILE = "policy_truth_audit.csv"
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def fetch_reddit(limit=50):
    # We fetch a larger batch because we are going to filter them by subreddit
    url = f"https://www.reddit.com/r/{'+'.join(TARGET_SUBS)}/.json?limit={limit}"
    headers = {"User-Agent": "Mozilla/5.0 TruthScorer/2.0"}
    try:
        response = requests.get(url, headers=headers, timeout=10)
        return response.json().get('data', {}).get('children', [])
    except: return []

def analyze_truthfulness(p_data):
    """Sends post to GPT-4o-mini with multi-component reasoning."""
    prompt = f"""
    Evaluate TRUTHFULNESS for this Canadian/Policy post.
    Current Date: Feb 26, 2026. 
    Key 2026 Facts: 
    - PBO confirmed ZERO population growth today due to NPR cuts.
    - 2026 PR Admission Target: 380,000.
    - LMIA validity: 6 months (reduced from 18).
    - 10% cap on low-wage TFWs.

    Subreddit: r/{p_data['subreddit']}
    Title: {p_data['title']}
    Content: {p_data.get('selftext', '')[:500]}

    Return JSON with these exact keys:
    1. "score": (0-10 or "N/A")
    2. "factual_check": (Verify numbers/laws mentioned)
    3. "context_check": (How it fits 2026 policy landscape)
    4. "verdict_summary": (One sentence final thought)
    """
    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )
        return json.loads(response.choices[0].message.content)
    except: return {"score": "Error"}

def save_to_csv(data_list):
    file_exists = os.path.isfile(CSV_FILE)
    # New headers reflecting the broken-down reasoning
    headers = ['date', 'score', 'subreddit', 'title', 'factual_check', 'context_check', 'verdict', 'url']
    with open(CSV_FILE, mode='a', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        if not file_exists: writer.writeheader()
        for p in data_list:
            writer.writerow({
                'date': datetime.now().strftime("%Y-%m-%d"),
                'score': p['score'],
                'subreddit': p['subreddit'],
                'title': p['title'],
                'factual_check': p['reasoning']['factual_check'],
                'context_check': p['reasoning']['context_check'],
                'verdict': p['reasoning']['verdict_summary'],
                'url': f"https://reddit.com{p['permalink']}"
            })

def main():
    print(f"--- MONITORING: {', '.join(TARGET_SUBS)} ---")
    posts = fetch_reddit()
    scored_results = []

    for post in posts:
        p = post['data']
        # Filter again to be safe
        if p['subreddit'].lower() not in TARGET_SUBS: continue
        
        analysis = analyze_truthfulness(p)
        score_val = analysis.get('score')
        
        print(f"-> [{score_val}] {p['title'][:50]}...")
        
        try:
            numeric_score = float(score_val)
            scored_results.append({**p, "score": numeric_score, "reasoning": analysis})
        except: continue

    if scored_results:
        worst_10 = sorted(scored_results, key=lambda x: x['score'])[:10]
        save_to_csv(worst_10)
        
        print("\n--- DETAILED REASONING FOR WORST POSTS ---")
        for p in worst_10:
            print(f"\nTITLE: {p['title']}")
            print(f"SCORE: {p['score']}/10")
            print(f"FACTS: {p['reasoning']['factual_check']}")
            print(f"CONTEXT: {p['reasoning']['context_check']}")
            print(f"VERDICT: {p['reasoning']['verdict_summary']}")

if __name__ == "__main__":
    main()
