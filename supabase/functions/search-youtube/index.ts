// Deploy with: supabase functions deploy search-youtube
// Set secret: supabase secrets set YOUTUBE_API_KEY=your_key
import { serve } from "https://deno.land/std@0.224.0/http/server.ts"

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
}
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors })
  try {
    const { query } = await req.json()
    if (typeof query !== "string" || query.trim().length < 1 || query.length > 100) {
      return new Response(JSON.stringify({ error: "Search must be 1–100 characters." }), { status: 400, headers: { ...cors, "Content-Type": "application/json" } })
    }
    const key = Deno.env.get("YOUTUBE_API_KEY")
    if (!key) throw new Error("Missing YOUTUBE_API_KEY function secret.")
    const url = new URL("https://www.googleapis.com/youtube/v3/search")
    url.search = new URLSearchParams({ part: "snippet", type: "video", videoCategoryId: "10", maxResults: "12", q: query.trim(), key }).toString()
    const response = await fetch(url)
    const payload = await response.json()
    if (!response.ok) throw new Error(payload.error?.message || "YouTube search failed.")
    const items = (payload.items || []).map((item: any) => ({
      videoId: item.id.videoId,
      title: item.snippet.title,
      artist: item.snippet.channelTitle,
      thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || "",
    }))
    return new Response(JSON.stringify({ items }), { headers: { ...cors, "Content-Type": "application/json" } })
  } catch (error) {
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Unexpected search error" }), { status: 500, headers: { ...cors, "Content-Type": "application/json" } })
  }
})
