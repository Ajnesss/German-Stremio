const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');

const BASE_URL = 'https://s.to';
const RD_API_KEY = process.env.RD_API_KEY || '';

const manifest = {
    id: 'org.stremio.germandub',
    version: '1.0.0',
    name: 'German Dub (s.to)',
    description: 'German dubbed streams from s.to with Real-Debrid integration',
    logo: 'https://i.imgur.com/qlfXn6E.png',
    resources: ['stream'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

// Helper: Search s.to for a title
async function searchSto(query, type) {
    try {
        const searchUrl = `${BASE_URL}/ajax/search`;
        const response = await axios.post(searchUrl, `keyword=${encodeURIComponent(query)}`, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
                'Origin': BASE_URL,
                'Referer': `${BASE_URL}/`
            },
            timeout: 10000
        });
        
        const $ = cheerio.load(response.data);
        const results = [];
        
        $('a').each((i, el) => {
            const link = $(el).attr('href');
            const title = $(el).text().trim();
            if (link && title) {
                const isMovie = link.includes('/filme/');
                const isSeries = link.includes('/serie/');
                
                if ((type === 'movie' && isMovie) || (type === 'series' && isSeries)) {
                    results.push({
                        title,
                        url: link.startsWith('http') ? link : BASE_URL + link
                    });
                }
            }
        });
        
        return results;
    } catch (error) {
        console.error('Search error:', error.message);
        return [];
    }
}

// Helper: Get available hosters for an episode/movie
async function getHosters(pageUrl, season = null, episode = null) {
    try {
        let targetUrl = pageUrl;
        
        if (season !== null && episode !== null) {
            targetUrl = `${pageUrl}/staffel-${season}/episode-${episode}`;
        }
        
        console.log(`Fetching hosters from: ${targetUrl}`);
        
        const response = await axios.get(targetUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8'
            },
            timeout: 15000
        });
        
        const $ = cheerio.load(response.data);
        const hosters = [];
        
        // s.to uses language keys: 1 = German, 2 = English, 3 = German Sub
        $('.hosterSiteVideo .generateInlinePlayer').each((i, el) => {
            const $el = $(el);
            const langKey = $el.attr('data-lang-key');
            
            if (langKey === '1' || langKey === '3') {
                const linkId = $el.attr('data-link-id');
                const hosterName = $el.find('h4').text().trim() || $el.find('.name').text().trim() || 'Unknown';
                
                if (linkId) {
                    hosters.push({
                        name: hosterName,
                        redirectUrl: `${BASE_URL}/redirect/${linkId}`,
                        language: langKey === '1' ? 'German Dub' : 'German Sub'
                    });
                }
            }
        });
        
        if (hosters.length === 0) {
            $('a[data-link-id]').each((i, el) => {
                const $el = $(el);
                const langKey = $el.attr('data-lang-key');
                
                if (langKey === '1' || langKey === '3') {
                    const linkId = $el.attr('data-link-id');
                    const hosterName = $el.find('h4').text().trim() || $el.text().trim() || 'Unknown';
                    
                    if (linkId) {
                        hosters.push({
                            name: hosterName,
                            redirectUrl: `${BASE_URL}/redirect/${linkId}`,
                            language: langKey === '1' ? 'German Dub' : 'German Sub'
                        });
                    }
                }
            });
        }
        
        if (hosters.length === 0) {
            $('a[href*="/redirect/"]').each((i, el) => {
                const href = $(el).attr('href');
                const hosterName = $(el).text().trim() || 'Unknown';
                
                hosters.push({
                    name: hosterName,
                    redirectUrl: href.startsWith('http') ? href : BASE_URL + href,
                    language: 'German'
                });
            });
        }
        
        return hosters;
    } catch (error) {
        console.error('Get hosters error:', error.message);
        return [];
    }
}

// Helper: Follow redirect to get actual hoster URL
async function resolveRedirect(redirectUrl) {
    try {
        console.log(`Resolving redirect: ${redirectUrl}`);
        
        const response = await axios.get(redirectUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                'Referer': BASE_URL
            },
            maxRedirects: 5,
            timeout: 15000
        });
        
        if (response.request && response.request.res && response.request.res.responseUrl) {
            const finalUrl = response.request.res.responseUrl;
            if (finalUrl !== redirectUrl && !finalUrl.includes('s.to')) {
                return finalUrl;
            }
        }
        
        const $ = cheerio.load(response.data);
        const scriptContent = $('script').text();
        
        let urlMatch = scriptContent.match(/location\.href\s*=\s*["']([^"']+)["']/);
        if (urlMatch) return urlMatch[1];
        
        urlMatch = scriptContent.match(/window\.location\s*=\s*["']([^"']+)["']/);
        if (urlMatch) return urlMatch[1];
        
        const dataUrl = $('[data-url]').attr('data-url');
        if (dataUrl) return dataUrl;
        
        const metaRefresh = $('meta[http-equiv="refresh"]').attr('content');
        if (metaRefresh) {
            const match = metaRefresh.match(/url=(.+)/i);
            if (match) return match[1].trim();
        }
        
        const iframeSrc = $('iframe').attr('src');
        if (iframeSrc && !iframeSrc.includes('s.to')) {
            return iframeSrc;
        }
        
        return null;
    } catch (error) {
        console.error('Resolve redirect error:', error.message);
        return null;
    }
}

// Helper: Unrestrict link via Real-Debrid
async function unrestrictWithRD(link) {
    try {
        console.log(`Unrestricting with RD: ${link}`);
        
        const response = await axios.post(
            'https://api.real-debrid.com/rest/1.0/unrestrict/link',
            `link=${encodeURIComponent(link)}`,
            {
                headers: {
                    'Authorization': `Bearer ${RD_API_KEY}`,
                    'Content-Type': 'application/x-www-form-urlencoded'
                },
                timeout: 15000
            }
        );
        
        if (response.data && response.data.download) {
            return {
                url: response.data.download,
                filename: response.data.filename,
                filesize: response.data.filesize,
                host: response.data.host
            };
        }
        
        return null;
    } catch (error) {
        const errorMsg = error.response?.data?.error || error.message;
        console.error('Real-Debrid error:', errorMsg);
        return null;
    }
}

// Helper: Get title info from IMDB ID
async function getMetaInfo(imdbId) {
    try {
        const response = await axios.get(`https://www.omdbapi.com/?i=${imdbId}&apikey=8e4dcdac`, {
            timeout: 10000
        });
        
        if (response.data && response.data.Response === 'True') {
            return {
                title: response.data.Title,
                year: response.data.Year,
                type: response.data.Type === 'movie' ? 'movie' : 'series'
            };
        }
        
        const cinemetaResp = await axios.get(`https://v3-cinemeta.strem.io/meta/movie/${imdbId}.json`, {
            timeout: 10000
        });
        
        if (cinemetaResp.data && cinemetaResp.data.meta) {
            return {
                title: cinemetaResp.data.meta.name,
                year: cinemetaResp.data.meta.year,
                type: cinemetaResp.data.meta.type
            };
        }
        
        return null;
    } catch (error) {
        console.error('Meta info error:', error.message);
        return null;
    }
}

// Helper: Format file size
function formatFileSize(bytes) {
    if (!bytes) return '';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + sizes[i];
}

// Stream handler function
async function handleStream(type, id) {
    console.log(`\n========================================`);
    console.log(`Stream request: type=${type}, id=${id}`);
    console.log(`========================================`);
    
    if (!RD_API_KEY) {
        console.log('No Real-Debrid API key configured');
        return { streams: [] };
    }
    
    const streams = [];
    
    try {
        const parts = id.split(':');
        const imdbId = parts[0];
        const season = parts.length > 1 ? parseInt(parts[1]) : null;
        const episode = parts.length > 2 ? parseInt(parts[2]) : null;
        
        const metaInfo = await getMetaInfo(imdbId);
        
        if (!metaInfo) {
            console.log('Could not get meta info for:', imdbId);
            return { streams: [] };
        }
        
        console.log(`Looking for: ${metaInfo.title} (${metaInfo.year})`);
        
        const searchResults = await searchSto(metaInfo.title, type);
        
        if (searchResults.length === 0) {
            console.log('No results found on s.to');
            return { streams: [] };
        }
        
        console.log(`Found ${searchResults.length} results on s.to`);
        
        const bestMatch = searchResults[0];
        console.log(`Using: ${bestMatch.title} - ${bestMatch.url}`);
        
        const hosters = await getHosters(bestMatch.url, season, episode);
        
        console.log(`Found ${hosters.length} hosters`);
        
        for (const hoster of hosters) {
            try {
                const actualUrl = await resolveRedirect(hoster.redirectUrl);
                
                if (!actualUrl) {
                    console.log(`Could not resolve: ${hoster.name}`);
                    continue;
                }
                
                console.log(`Resolved ${hoster.name}: ${actualUrl}`);
                
                const rdResult = await unrestrictWithRD(actualUrl);
                
                if (rdResult) {
                    const streamTitle = rdResult.filesize 
                        ? `🇩🇪 ${hoster.name} (RD)\n${formatFileSize(rdResult.filesize)}`
                        : `🇩🇪 ${hoster.name} (RD)`;
                    
                    streams.push({
                        name: 'German Dub',
                        title: streamTitle,
                        url: rdResult.url,
                        behaviorHints: {
                            bingeGroup: `germandub-${imdbId}`,
                            notWebReady: false
                        }
                    });
                    console.log(`✓ Added stream from ${hoster.name}`);
                } else {
                    console.log(`✗ RD could not unrestrict: ${hoster.name}`);
                }
            } catch (error) {
                console.error(`Error processing ${hoster.name}:`, error.message);
            }
        }
        
    } catch (error) {
        console.error('Stream handler error:', error);
    }
    
    console.log(`Returning ${streams.length} streams`);
    return { streams };
}

// Express server
const app = express();

// Landing page
app.get('/', (req, res) => {
    const configured = RD_API_KEY ? 'Yes ✓' : 'No ✗';
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>German Dub Stremio Addon</title>
            <style>
                body {
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    max-width: 600px;
                    margin: 50px auto;
                    padding: 20px;
                    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
                    color: #fff;
                    min-height: 100vh;
                }
                h1 { color: #fff; }
                .card {
                    background: rgba(255,255,255,0.1);
                    padding: 20px;
                    border-radius: 10px;
                    margin: 20px 0;
                }
                .status { 
                    padding: 10px; 
                    border-radius: 5px; 
                    margin: 10px 0;
                    background: ${RD_API_KEY ? 'rgba(0,255,0,0.2)' : 'rgba(255,0,0,0.2)'};
                }
                code {
                    background: rgba(0,0,0,0.3);
                    padding: 10px;
                    display: block;
                    border-radius: 5px;
                    word-break: break-all;
                    margin: 10px 0;
                }
                a { color: #4a9eff; }
            </style>
        </head>
        <body>
            <h1>🇩🇪 German Dub Addon</h1>
            <p>Stream German dubbed content from s.to via Real-Debrid</p>
            
            <div class="card">
                <h3>Status</h3>
                <div class="status">Real-Debrid API Key Configured: ${configured}</div>
            </div>
            
            <div class="card">
                <h3>Install in Stremio</h3>
                <p>Copy this URL and add it in Stremio:</p>
                <code>https://${req.get('host')}/manifest.json</code>
                <p>Or click: <a href="stremio://${req.get('host')}/manifest.json">Install Addon</a></p>
            </div>
            
            ${!RD_API_KEY ? `
            <div class="card">
                <h3>⚠️ Setup Required</h3>
                <p>Add your Real-Debrid API key as an environment variable:</p>
                <p><strong>RD_API_KEY</strong> = your_api_key</p>
                <p>Get your API key from: <a href="https://real-debrid.com/apitoken" target="_blank">real-debrid.com/apitoken</a></p>
            </div>
            ` : ''}
        </body>
        </html>
    `);
});

// Manifest endpoint
app.get('/manifest.json', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    res.json(manifest);
});

// Stream endpoint
app.get('/stream/:type/:id.json', async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Content-Type', 'application/json');
    
    try {
        const type = req.params.type;
        const id = req.params.id.replace('.json', '');
        const result = await handleStream(type, id);
        res.json(result);
    } catch (error) {
        console.error('Stream error:', error);
        res.json({ streams: [] });
    }
});

const PORT = process.env.PORT || 7000;

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║           German Dub Stremio Addon (s.to)                  ║
╠════════════════════════════════════════════════════════════╣
║  Addon URL: http://localhost:${PORT}/manifest.json            ║
║  RD API Key: ${RD_API_KEY ? 'Configured ✓' : 'NOT SET ✗'}                              
╚════════════════════════════════════════════════════════════╝
    `);
});
