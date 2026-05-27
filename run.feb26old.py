import requests
import json
import time
import os
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

# --- CONFIGURATION ---
HEADERS = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) TruthScorer/1.0"}
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def fetch_reddit_posts(limit=30):
    url = f"https://www.reddit.com/.json?limit={limit}"
    print(f"[LOG] Fetching: {url}")
    
    try:
        response = requests.get(url, headers=HEADERS, timeout=10)
        print(f"[LOG] Reddit Response Status: {response.status_code}")
        
        if response.status_code != 200:
            return []
            
        data = response.json()
        posts = data.get('data', {}).get('children', [])
        print(f"[LOG] Successfully retrieved {len(posts)} posts from Reddit.")
        return posts
    except Exception as e:
        print(f"[ERR] Failed to connect to Reddit: {e}")
        return []

def analyze_truthfulness(title, body, subreddit):
    # Shorten body for token efficiency
    snippet = (body[:400] + '...') if len(body) > 400 else body
    content = f"Subreddit: r/{subreddit}\nTitle: {title}\nText: {snippet}"
    
    prompt = f"""
    Analyze this Reddit post for truthfulness.
    - If it's a factual claim, score it 0 (False) to 10 (True).
    - If it's purely opinion, a joke, or meta-chat, return "N/A" for the score.
    
    Post:
    {content}
    
    Return JSON only: {{"score": float_or_string, "reason": "string"}}
    """
    
    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )
        res_text = response.choices[0].message.content
        return json.loads(res_text)
    except Exception as e:
        return {"score": "Error", "reason": str(e)}

def main():
    print("--- STARTING TRUTH SCORER ---")
    raw_posts = fetch_reddit_posts(limit=20) # Start with 20 for testing
    
    if not raw_posts:
        print("[CRIT] No data to process. Check your internet or Reddit status.")
        return

    scored_results = []

    for i, post in enumerate(raw_posts, 1):
        p = post['data']
        title_summary = p['title'][:50] + "..."
        
        print(f"\n[LOG] ({i}/{len(raw_posts)}) Analyzing: {title_summary}")
        
        analysis = analyze_truthfulness(p['title'], p['selftext'], p['subreddit'])
        score_val = analysis.get('score')
        reason = analysis.get('reason', 'No reason provided.')
        
        # Log the raw decision from the LLM
        print(f"      -> LLM Result: Score={score_val} | Reason: {reason[:80]}")

        # Try to parse the score
        try:
            if score_val == "N/A":
                print("      -> Action: Skipped (Non-factual content)")
                continue
                
            numeric_score = float(score_val)
            scored_results.append({
                "title": p['title'],
                "score": numeric_score,
                "reason": reason,
                "url": f"https://reddit.com{p['permalink']}"
            })
            print(f"      -> Action: KEPT (Score {numeric_score})")
        except (ValueError, TypeError):
            print(f"      -> Action: Skipped (Invalid score format: {score_val})")

    # Final Ranking
    print("\n" + "="*40)
    if not scored_results:
        print("RESULT: No factual posts were found in this batch.")
    else:
        worst_10 = sorted(scored_results, key=lambda x: x['score'])[:10]
        print(f"RESULT: Found {len(scored_results)} factual posts. Displaying the 10 worst:")
        print("="*40)
        for idx, item in enumerate(worst_10, 1):
            print(f"{idx}. [{item['score']}/10] {item['title']}")
            print(f"   Why: {item['reason']}")
            print(f"   Link: {item['url']}\n")

if __name__ == "__main__":
    main()
