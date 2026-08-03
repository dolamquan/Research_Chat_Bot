import { ExternalLink, Loader2, MessageSquare, Search } from "lucide-react";
import { useState } from "react";

import { callMcpTool } from "../api";

type RedditPost = {
  id?: string;
  title?: string;
  text?: string;
  url?: string;
  subreddit?: string;
  author?: string;
  score?: number;
  num_comments?: number;
};

function postKey(post: RedditPost, index: number): string {
  return post.id || post.url || `${post.title || "reddit-post"}-${index}`;
}

function postMeta(post: RedditPost): string {
  const parts = [
    post.subreddit ? `r/${String(post.subreddit).replace(/^r\//i, "")}` : "Reddit",
    post.author ? `u/${post.author}` : "",
    typeof post.score === "number" ? `${post.score} score` : "",
    typeof post.num_comments === "number" ? `${post.num_comments} comments` : "",
  ].filter(Boolean);
  return parts.join(" - ");
}

export function RedditView() {
  const [query, setQuery] = useState("graph RAG discussions");
  const [subreddit, setSubreddit] = useState("");
  const [limit, setLimit] = useState(10);
  const [posts, setPosts] = useState<RedditPost[]>([]);
  const [status, setStatus] = useState("");
  const [isSearching, setIsSearching] = useState(false);

  async function searchReddit() {
    const trimmed = query.trim();
    if (!trimmed || isSearching) return;

    setIsSearching(true);
    setStatus("Searching Reddit...");
    try {
      const response = await callMcpTool({
        toolName: "reddit.search_posts",
        arguments: {
          query: trimmed,
          subreddit: subreddit.trim() || undefined,
          limit,
        },
      });
      const result = response.result as { posts?: RedditPost[]; query?: string };
      const nextPosts = Array.isArray(result.posts) ? result.posts : [];
      setPosts(nextPosts);
      setStatus(
        nextPosts.length
          ? `Found ${nextPosts.length} Reddit posts.`
          : "No Reddit posts matched that search.",
      );
    } catch (error) {
      setPosts([]);
      setStatus(
        error instanceof Error
          ? `Could not search Reddit: ${error.message}`
          : "Could not search Reddit.",
      );
    } finally {
      setIsSearching(false);
    }
  }

  return (
    <section className="h-full min-h-0 flex flex-col">
      <div className="shrink-0 border-b border-border bg-card px-5 md:px-8 py-5">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded bg-primary/10 border border-primary/25 flex items-center justify-center text-primary">
            <MessageSquare size={16} />
          </div>
          <div className="min-w-0 flex-1">
            <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              reddit research signals
            </p>
            <h2 className="mt-1 text-2xl font-semibold tracking-tight text-foreground">
              Search Reddit discussions
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Find practitioner conversations, pain points, and community context related to your research topic.
            </p>
          </div>
        </div>

        <form
          className="mt-5 rounded border border-border bg-background p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void searchReddit();
          }}
        >
          <label className="block">
            <span className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
              Search topic
            </span>
            <textarea
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              rows={3}
              placeholder="Example: graph RAG production problems, retrieval evaluation, vector database latency"
              className="mt-2 block w-full resize-none rounded border border-border bg-card px-3 py-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
            />
          </label>

          <div className="mt-3 grid gap-2 md:grid-cols-[1fr_150px_160px]">
            <input
              value={subreddit}
              onChange={(event) => setSubreddit(event.target.value)}
              placeholder="Optional subreddit, e.g. MachineLearning"
              className="h-9 w-full rounded border border-border bg-card px-3 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-primary/60"
            />
            <select
              value={limit}
              onChange={(event) => setLimit(Number(event.target.value))}
              className="h-9 rounded border border-border bg-card px-3 text-xs text-foreground outline-none focus:border-primary/60"
            >
              {[5, 10, 15, 20, 25].map((value) => (
                <option key={value} value={value}>
                  {value} posts
                </option>
              ))}
            </select>
            <button
              type="submit"
              disabled={!query.trim() || isSearching}
              className="h-9 rounded bg-primary text-primary-foreground text-xs font-medium flex items-center justify-center gap-2 disabled:opacity-40"
            >
              {isSearching ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
              Search Reddit
            </button>
          </div>
        </form>

        {status && (
          <p
            className={`mt-3 text-xs ${
              status.startsWith("Could not") ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {status}
          </p>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 md:px-8 py-5">
        {posts.length === 0 ? (
          <div className="h-full min-h-[360px] rounded border border-border bg-card flex items-center justify-center px-8 text-center text-sm text-muted-foreground">
            Reddit results will appear here. Use this when you want community discussions instead of indexed papers.
          </div>
        ) : (
          <div className="space-y-3">
            {posts.map((post, index) => (
              <article key={postKey(post, index)} className="rounded border border-border bg-card p-4">
                <div className="flex items-start gap-3">
                  <div className="mt-1 flex h-8 w-8 shrink-0 items-center justify-center rounded border border-primary/25 bg-primary/10 text-primary">
                    <MessageSquare size={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-base font-semibold text-foreground break-words">
                      {post.title || "Reddit post"}
                    </p>
                    <p className="mt-1 font-mono text-[10px] text-muted-foreground break-words">
                      {postMeta(post)}
                    </p>
                    {post.text && (
                      <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-muted-foreground break-words">
                        {post.text}
                      </p>
                    )}
                  </div>
                  {post.url && (
                    <a
                      href={post.url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 rounded border border-border px-3 py-2 text-xs font-medium text-foreground hover:border-primary/40 hover:text-primary"
                    >
                      <span className="inline-flex items-center gap-2">
                        <ExternalLink size={13} />
                        Open
                      </span>
                    </a>
                  )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
