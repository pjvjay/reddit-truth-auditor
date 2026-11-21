import os
import requests
import json
import csv
from datetime import datetime
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

# --- CONFIG ---
CSV_FILE = "reddit_truth_audit.csv"
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))

def save_to_csv(data_list):
    """Appends the worst posts to a local CSV file."""
    file_exists = os.path.isfile(CSV_FILE)
    
    # Define the columns for our audit database
    headers = ['date', 'score', 'subreddit', 'title', 'reason', 'url']
    
    with open(CSV_FILE, mode='a', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=headers)
        
        # Write header only if the file is new
        if not file_exists:
            writer.writeheader()
            
        for post in data_list:
            writer.writerow({
                'date': datetime.now().strftime("%Y-%m-%d"),
                'score': post['score'],
                'subreddit': post['subreddit'],
                'title': post['title'],
                'reason': post['reason'],
                'url': post['url']
            })
    print(f"[LOG] Successfully saved {len(data_list)} audit records to {CSV_FILE}")

# ... (Keep your fetch and analyze functions from before) ...

def main():
    # 1. Fetch
    raw_posts = fetch_reddit_posts(limit=100) 
    scored_results = []

    # 2. Analyze
    for post in raw_posts:
        p = post['data']
        # We now pass the full data object to the analyzer
        analysis = analyze_truthfulness(p) 
        
        try:
            score = float(analysis.get('score'))
            scored_results.append({
                **p, # Keep original reddit data
                "score": score,
                "reason": analysis.get('reason')
            })
        except: continue

    # 3. Filter & Save
    if scored_results:
        # Sort by worst (lowest score) and take the worst 10
        worst_10 = sorted(scored_results, key=lambda x: x['score'])[:10]
        
        # Save to CSV
        save_to_csv(worst_10)
