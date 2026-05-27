import os
import json
import csv
import asyncio
import time
import requests
from datetime import datetime
from dotenv import load_dotenv

# LangChain & OpenAI
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser
from langchain_community.callbacks import get_openai_callback

# GPT-Researcher
from gpt_researcher import GPTResearcher

load_dotenv()

# --- CONFIG ---
TARGET_SUBS = ['lmiascams', 'destiny', 'canadian', 'tourism', 'askcanada']
CSV_FILE = "final_policy_audit.csv"
# 2026 Costs (USD per 1M tokens)
COST_INPUT = 0.15 / 1000000
COST_OUTPUT = 0.60 / 1000000

llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)

# --- PROMPTS ---
extract_prompt = ChatPromptTemplate.from_template("""
Identify the factual claim in this Reddit post for verification.
Post: {content} | Flair: {flair}
Return ONLY JSON: {{"is_verifiable": bool, "query": "string", "summary": "string"}}
""")

audit_prompt = ChatPromptTemplate.from_template("""
Date: {date}
Audit the claim based on this Research Report.
Claim: {query}
Report: {report}
Return ONLY JSON: 
{{
  "truth_score": (0-10),
  "sarcasm_score": (0-10),
  "factual_check": "Detailed numbers/laws",
  "verdict": "Final precision statement"
}}
""")

async def get_deep_research(query):
    """Triggers autonomous research agents."""
    researcher = GPTResearcher(query=query, report_type="research_report")
    await researcher.conduct_research()
    return await researcher.write_report()

async def audit_post(post_data):
    p = post_data['data']
    start_time = time.time()
    
    with get_openai_callback() as cb:
        # 1. Extraction
        id_chain = extract_prompt | llm | JsonOutputParser()
        info = id_chain.invoke({
            "content": p['title'] + " " + p.get('selftext', '')[:300],
            "flair": p.get('link_flair_text', 'None')
        })
        
        if not info['is_verifiable']:
            return None

        # 2. Deep Research (The heavy lifting)
        report = await get_deep_research(info['query'])
        
        # 3. Final Synthesis
        audit_chain = audit_prompt | llm | JsonOutputParser()
        res = audit_chain.invoke({
            "date": "2026-02-26",
            "query": info['query'],
            "report": report
        })
        
        duration = round(time.time() - start_time, 2)
        print(f"   [RESULT] Score: {res['truth_score']} | Cost: ${cb.total_cost:.4f} | Time: {duration}s")
        
        return {**res, "subreddit": p['subreddit'], "title": p['title'], "url": f"https://reddit.com{p['permalink']}"}

def save_result(row):
    file_exists = os.path.isfile(CSV_FILE)
    with open(CSV_FILE, 'a', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=['date','truth_score','sarcasm_score','subreddit','title','factual_check','verdict','url'])
        if not file_exists: writer.writeheader()
        row['date'] = "2026-02-26"
        writer.writerow(row)

async def main():
    print(f"--- STARTING PRECISION AUDIT (200 Post Capacity) ---")
    url = f"https://www.reddit.com/r/{'+'.join(TARGET_SUBS)}/.json?limit=100"
    headers = {"User-Agent": "Mozilla/5.0 PolicyAgent/1.0"}
    
    try:
        posts = requests.get(url, headers=headers).json()['data']['children']
        print(f"Fetched {len(posts)} posts from target subreddits.")
    except Exception as e:
        print(f"Fetch failed: {e}")
        return

    for i, post in enumerate(posts, 1):
        print(f"({i}/{len(posts)}) Investigating: {post['data']['title'][:50]}...")
        result = await audit_post(post)
        if result:
            save_result(result)
        # Small sleep to prevent rate limits
        await asyncio.sleep(0.5)

if __name__ == "__main__":
    asyncio.run(main())
