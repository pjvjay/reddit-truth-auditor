import requests
import json
import time
from openai import OpenAI  # Or your preferred LLM library

# 1. SETUP
# Use a descriptive User-Agent so Reddit doesn't block the script
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TruthScorer/1.0"}
LLM_CLIENT = OpenAI(api_key="YOUR_OPENAI_API_KEY")

def fetch_reddit_posts(limit=25):
    """Fetches the hot posts from the front page using the .json workaround."""
    url = f"https://www.reddit.com/.json?limit={limit}"
    response = requests.get(url, headers=HEADERS)
    
    if response.status_code != 200:
        print(f"Error: Could not fetch Reddit data (Status {response.status_code})")
        return []
    
    data = response.json()
    return data['data']['children']

def analyze_truthfulness(title, body, subreddit):
    """Sends post content to the LLM for a truthfulness score."""
    content = f"Subreddit: r/{subreddit}\nTitle: {title}\nText: {body[:500]}"
    
    prompt = f"""
    Evaluate the truthfulness of this Reddit post.
    - If it's a factual claim, score it 0 (False/Misleading) to 10 (Verifiable Fact).
    - If it's an opinion, joke, or creative writing, return "N/A".
    - Provide a one-sentence reason.

    Post Content:
    {content}

    Return JSON only: {{"score": float_or_string, "reason": "string"}}
    """
    
    try:
        response = LLM_CLIENT.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"}
        )
        return json.loads(response.choices[0].message.content)
    except Exception as e:
        return {"score": "Error", "reason": str(e)}

def main():
    print("Step 1: Fetching Reddit feed...")
    raw_posts = fetch_reddit_posts(limit=30)
    scored_results = []

    print(f"Step 2: Analyzing {len(raw_posts)} posts (this may take a minute)...")
    for post in raw_posts:
        p_data = post['data']
        analysis = analyze_truthfulness(p_data['title'], p_data['selftext'], p_data['subreddit'])
        
        # Only track if the LLM gave a numeric score (ignoring N/A)
        if isinstance(analysis.get('score'), (int, float)):
            scored_results.append({
                "title": p_data['title'],
                "score": analysis['score'],
                "reason": analysis['reason'],
                "url": f"https://reddit.com{p_data['permalink']}"
            })
        # Small sleep to be polite to the LLM API
        time.sleep(0.5)

    # Step 3: Sort by score ascending (0 is the most "untruthful")
    worst_10 = sorted(scored_results, key=lambda x: x['score'])[:10]

    print("\n--- THE 10 LEAST TRUTHFUL POSTS ---")
    for i, post in enumerate(worst_10, 1):
        print(f"{i}. [{post['score']}/10] {post['title']}")
        print(f"   Reason: {post['reason']}")
        print(f"   Link: {post['url']}\n")

if __name__ == "__main__":
    main()
