import os
import json
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser
from langchain_community.tools import DuckDuckGoSearchRun
from dotenv import load_dotenv

load_dotenv()

# --- INITIALIZE AGENT COMPONENTS ---
# We use temperature 0 for factual accuracy
llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
search_tool = DuckDuckGoSearchRun()

# --- STEP 1: CONTENT IDENTIFICATION ---
# Extracts the plain text summary and the specific claim to be searched
summary_prompt = ChatPromptTemplate.from_template("""
Analyze this Reddit post content:
{post_content}

1. Identify the type of content (Political News, Community Meme, Personal Story, etc.)
2. Provide a 1-sentence plain text summary.
3. Extract the primary factual claim to be verified (if any).

Return ONLY JSON:
{{
  "content_type": "string",
  "summary": "string",
  "search_query": "string"
}}
""")

# --- STEP 2: SEARCH & AUDIT ---
audit_prompt = ChatPromptTemplate.from_template("""
Current Date: Feb 26, 2026.
Audit the following claim based on the provided web evidence.

Claim: {search_query}
Web Evidence: {evidence}

Provide scores (0-10) for:
1. truth_score
2. sarcasm_score (Check for flairs or hyperbolic language)

Also provide breakdown keys:
- "factual_check": Specific numbers/laws found.
- "context_check": How it fits the 2026 PBO/IRCC landscape (Zero growth, 380k PR target).
- "verdict": Final summary.

Return ONLY JSON.
""")

def run_research_audit(post_text):
    print("\n[PHASE 1] Summarizing & Identifying Claim...")
    id_chain = summary_prompt | llm | JsonOutputParser()
    id_results = id_chain.invoke({"post_content": post_text})
    
    query = id_results.get('search_query')
    if not query or query.lower() == "none":
        return {"status": "Skipped", "reason": "No verifiable claim found."}

    print(f"[PHASE 2] Searching Web for: {query}")
    # This step looks up real-time 2026 facts
    search_results = search_tool.run(query)

    print("[PHASE 3] Final Truthfulness Audit...")
    audit_chain = audit_prompt | llm | JsonOutputParser()
    final_audit = audit_chain.invoke({
        "search_query": query,
        "evidence": search_results
    })
    
    return {**id_results, **final_audit}

# Test with a post from your feed
test_post = "PBO says Canada population growth is zero for 2026."
result = run_research_audit(test_post)
print(json.dumps(result, indent=2))
