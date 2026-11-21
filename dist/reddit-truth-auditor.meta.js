// ==UserScript==
// @name         Reddit Truth Auditor
// @namespace    https://github.com/pjvjay/reddit-truth-auditor
// @version      2.0.0
// @description  Fact-checks the Reddit posts you are looking at and warns you about false or misleading content, with an optional community network for tracking propagating mistruths.
// @author       pjvjay
// @license      MIT
// @homepageURL  https://github.com/pjvjay/reddit-truth-auditor
// @supportURL   https://github.com/pjvjay/reddit-truth-auditor/issues
// @icon         https://www.reddit.com/favicon.ico
// @match        https://www.reddit.com/*
// @match        https://reddit.com/*
// @match        https://old.reddit.com/*
// @match        https://new.reddit.com/*
// @match        https://sh.reddit.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_registerMenuCommand
// @grant        GM_info
// @connect      api.openai.com
// @connect      api.tavily.com
// @connect      openrouter.ai
// @connect      localhost
// @connect      127.0.0.1
// @connect      *
// @run-at       document-idle
// @noframes
// @updateURL    https://raw.githubusercontent.com/pjvjay/reddit-truth-auditor/main/dist/reddit-truth-auditor.meta.js
// @downloadURL  https://raw.githubusercontent.com/pjvjay/reddit-truth-auditor/main/dist/reddit-truth-auditor.user.js
// ==/UserScript==
