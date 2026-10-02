/**
 * relay/tools/web-search.mjs — Web search via DuckDuckGo HTML search
 * 
 * Scrapes DuckDuckGo HTML search results directly (no API key needed).
 * Falls back to alternative sources if DDG is blocked.
 */

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://localhost:11434';

/**
 * Search the web
 */
export async function webSearch(query, options = {}) {
  const { maxResults = 5, timeout = 20000 } = options;

  // Try DuckDuckGo HTML search (most reliable, no API key)
  try {
    return await searchDuckDuckGo(query, maxResults, timeout);
  } catch (err) {
    console.log(`[web-search] DDG search failed: ${err.message}`);
  }

  // Fallback: try Ollama web search (cloud Ollama Pro feature)
  try {
    return await searchOllama(query, maxResults, timeout);
  } catch (err) {
    console.log(`[web-search] Ollama search failed: ${err.message}`);
  }

  return { source: 'none', query, results: [], error: 'All search providers failed' };
}

/**
 * DuckDuckGo HTML search — scrapes actual search results page
 */
async function searchDuckDuckGo(query, maxResults, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(
      `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`,
      {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        },
        signal: controller.signal,
      }
    );

    clearTimeout(timer);

    if (!res.ok) throw new Error(`DDG HTTP ${res.status}`);

    const html = await res.text();
    const results = [];

    // Parse DDG HTML results — extract result blocks using regex
    const resultRegex = /<div class="result results_links results_links_deep web-result[^>]*>(.*?)<\/div>\s*<\/div>\s*<\/div>/gs;
    let match;
    
    while ((match = resultRegex.exec(html)) !== null && results.length < maxResults) {
      const block = match[1];
      
      // Extract title
      const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      
      // Extract URL
      const urlMatch = block.match(/<a[^>]*class="result__a"[^>]*href="([^"]+)"/i);
      let url = urlMatch ? urlMatch[1] : '';
      if (url.startsWith('//')) url = 'https:' + url;
      if (url.includes('duckduckgo.com/l/?uddg=')) {
        const uddg = url.match(/uddg=([^&]+)/);
        if (uddg) url = decodeURIComponent(uddg[1]);
      }
      
      // Extract snippet
      const snippetMatch = block.match(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
      let snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : '';
      
      if (title && url) {
        results.push({ title, url, snippet });
      }
    }

    return { source: 'duckduckgo', query, results };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Ollama web search (cloud Ollama Pro feature)
 */
async function searchOllama(query, maxResults, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(`${OLLAMA_HOST}/api/web_search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, max_results: maxResults }),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
    const data = await res.json();
    return {
      source: 'ollama',
      query,
      results: (data.results || data.answers || []).slice(0, maxResults),
    };
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Format search results as a readable string
 */
export function formatResults(searchResult) {
  if (!searchResult.results || searchResult.results.length === 0) {
    return `No results found for "${searchResult.query}".`;
  }
  
  let output = `## Web Search: "${searchResult.query}"\n\n`;
  searchResult.results.forEach((r, i) => {
    output += `**${i + 1}. ${r.title || 'Untitled'}**\n`;
    if (r.url) output += `   URL: ${r.url}\n`;
    if (r.snippet) output += `   ${r.snippet}\n`;
    output += '\n';
  });
  output += `*(Source: ${searchResult.source})*`;
  return output;
}

export default { webSearch, formatResults };
