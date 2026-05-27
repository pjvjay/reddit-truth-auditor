import os
import json
from langchain_openai import ChatOpenAI
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.output_parsers import JsonOutputParser
from langchain_community.tools import DuckDuckGoSearchRun
from dotenv import load_dotenv

load_dotenv()

# --- INITIALIZE COMPONENTS ---
llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
search_tool = DuckDuckGoSearchRun()

# --- PROMPT 1: DATA EXTRACTION ---
extract_prompt = ChatPromptTemplate.from_template("""
Identify the specific factual claims or numbers in this Reddit post.
POST: {post_content}

Return ONLY JSON:
{{
  "content_type": "Political/Immigration/Other",
  "plain_text_summary": "One sentence summary",
  "extracted_numbers": ["list of any numbers/dates found"],
  "search_query": "Optimized search query for 2026 facts"
}}
""")

# --- PROMPT 2: DATA-BACKED VERDICT ---
audit_prompt = ChatPromptTemplate.from_template("""
Current Date: Feb 26, 2026.
Verify the user's claim against the search evidence.

USER CLAIM: {query}
WEB EVIDENCE: {evidence}

MASTER REFERENCE (Feb 26, 2026 PBO Report):
- Population Growth: 0.0% (Flat) for 2026.
- PR Admission Target: 380,000/year (2026-2028).
- NPR Outflow: 385,000 residents leaving in 2026.
- NPR Cap: <5% of population by end of 2027.

Return ONLY JSON:
{{
  "truth_score": (0-10),
  "sarcasm_score": (0-10),
  "factual_search_content": "Raw data found during search",
  "factual_verification": "Compare actual 2026 figures vs post claims",
  "verdict": "Final statement using ACTUAL 2026 FIGURES"
}}
""")

def run_precision_audit(post_text):
    # Phase 1: Summarize & Extract Query
    id_chain = extract_prompt | llm | JsonOutputParser()
    id_results = id_chain.invoke({"post_content": post_text})
    
    query = id_results.get('search_query')
    print(f"[LOG] Identified Claim: {id_results['plain_text_summary']}")

    # Phase 2: Live Search (Essential for today's PBO news)
    print(f"[LOG] Searching for actual 2026 figures...")
    search_results = search_tool.run(query)

    # Phase 3: Compare & Audit
    audit_chain = audit_prompt | llm | JsonOutputParser()
    final_audit = audit_chain.invoke({
        "query": query,
        "evidence": search_results
    })
    
    # Combine results for logging
    return {**id_results, **final_audit}

# --- TEST ---
if __name__ == "__main__":
    test_post = "I heard the PBO said growth is finally zero now."
    result = run_precision_audit(test_post)
    print(json.dumps(result, indent=2))
