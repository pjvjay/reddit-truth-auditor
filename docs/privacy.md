# Privacy

Reddit Truth Auditor has **no accounts, no analytics and no server of its own**. What leaves your browser depends only on what you configure.

## Always (when fact-checking)

| Sent to | What | Why |
|---|---|---|
| Your LLM provider (OpenAI by default, or the endpoint you set) | The post's title, subreddit, flair, linked URL and up to ~1,500 characters of its text; your reference facts | To extract and audit the claim |
| Tavily (only if you add a Tavily key) | A short search query derived from the claim | Web research |
| reddit.com (same site) | `/by_id/<ids>.json` requests | To read the full post text. These are the same requests the Reddit site itself makes. |

API keys are stored in your userscript manager's storage. They are sent only to their own API, are never written into the Reddit page, and are never included in reports.

## Stored on your device

A research log of analysed posts is kept in your userscript manager's storage for 30 days by default (configurable). It holds each post's title, subreddit, verdict, sources and public post metadata, and you can export or clear it (*Settings → Advanced*).

## Only if you join a community network (off by default)

Reports are sent **only for claims judged false**, or for claims already on the community list. Each report contains exactly:

- the canonical claim (subject, predicate, object, numbers, time, place, topic) and its proposition key;
- the verdict: truth score, confidence, tone, up to 3 source URLs, model name and a one-sentence verdict;
- a one-way hash of the Reddit post id and of the normalised linked URL;
- public post metadata: the linked site's **host only** (e.g. `edition.cnn.com`, never the path) and article kind, an outlet the post cites, upvotes, comments and crossposts;
- the subreddit name (can be switched off), the UTC day the post was created and the UTC day you saw it;
- a random anonymous install id, which you can reset at any time in Settings.

It never includes:
- post text or titles, or usernames (yours or the author's);
- your Reddit account, your browsing history or exact timestamps;
- URL paths or raw post ids.

*Settings → Community network → What exactly is shared?* shows the last batch actually sent.

**Offline:** analyses made while the server is unreachable (or, if you allow it, before you joined) are queued locally and sent later. You can discard the queue at any time.

**Matching is on your device.** Your script downloads the whole list of known mistruths and compares posts locally. The server is never asked about individual posts, so it cannot see what you read.

**Caveat:** Reddit post ids are public. Someone holding the server data could link a post hash back to the *public* post, but not to who viewed it. Engagement numbers make that link easier, and are public anyway.

The reference server stores no IP addresses (they are used in memory for rate limiting only) and publishes a claim only after several independent users have reported it. Server operators should publish their own retention policy. See [community-api.md §6](community-api.md#6-privacy).
