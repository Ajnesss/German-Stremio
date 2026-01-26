const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const express = require('express');

const BASE_URL = 'https://s.to';

// Manifest with configuration
function getManifest(config = {}) {
    return {
        id: 'org.stremio.germandub',
        version: '1.0.0',
        name: 'German Dub (s.to)',
        description: 'German dubbed streams from s.to with Real-Debrid integration',
        logo: 'https://i.imgur.com/qlfXn6E.png',
        resources: ['stream'],
        types: ['movie', 'series'],
        idPrefixes: ['tt'],
        catalogs: [],
        behaviorHints: {
            configurable: true,
            configurationRequired: true
        },
        config: [
            {
                key: 'rdApiKey',
                title: 'Real-Debrid API Key',
                type: 'text',
                required: true
            }
        ]
    };
}

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
async function unrestrictWithRD(link, apiKey) {
    try {
        console.log(`Unrestricting with RD: ${link}`);
        
        const response = await axios.post(
            'https://api.real-debrid.com/rest/1.0/unrestrict/link',
            `link=${encodeURIComponent(link)}`,
            {
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
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

// Create builder with config support
function createAddon(config) {
    const builder = new addonBuilder(getManifest(config));
    
    builder.defineStreamHandler(async ({ type, id }) => {
        console.log(`\n========================================`);
        console.log(`Stream request: type=${type}, id=${id}`);
        console.log(`========================================`);
        
        const rdApiKey = config.rdApiKey;
        
        if (!rdApiKey || rdApiKey === 'YOUR_REAL_DEBRID_API_KEY') {
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
                    
                    const rdResult = await unrestrictWithRD(actualUrl, rdApiKey);
                    
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
    });
    
    return builder;
}

// Express server with configuration support
const app = express();

// Landing page
app.get('/', (req, res) => {
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
                input {
                    width: 100%;
                    padding: 12px;
                    margin: 10px 0;
                    border: none;
                    border-radius: 5px;
                    font-size: 16px;
                    box-sizing: border-box;
                }
                button {
                    background: #e50914;
                    color: white;
                    border: none;
                    padding: 15px 30px;
                    border-radius: 5px;
                    font-size: 16px;
                    cursor: pointer;
                    width: 100%;
                }
                button:hover { background: #f40612; }
                .info { color: #aaa; font-size: 14px; }
                a { color: #4a9eff; }
            </style>
        </head>
        <body>
            <h1>🇩🇪 German Dub Addon</h1>
            <p>Stream German dubbed content from s.to via Real-Debrid</p>
            
            <div class="card">
                <h3>Configure Addon</h3>
                <p class="info">Enter your Real-Debrid API key to get started.</p>
                <p class="info">Get your API key from: <a href="https://real-debrid.com/apitoken" target="_blank">real-debrid.com/apitoken</a></p>
                
                <input type="text" id="apiKey" placeholder="Real-Debrid API Key">
                <button onclick="installAddon()">Install Addon</button>
            </div>
            
            <script>
                function installAddon() {
                    const apiKey = document.getElementById('apiKey').value.trim();
                    if (!apiKey) {
                        alert('Please enter your Real-Debrid API key');
                        return;
                    }
                    const config = encodeURIComponent(JSON.stringify({ rdApiKey: apiKey }));
                    const manifestUrl = window.location.origin + '/' + config + '/manifest.json';
                    window.location.href = 'stremio://' + manifestUrl.replace(/^https?:\\/\\//, '');
                }
            </script>
        </body>
        </html>
    `);
});

// Handle configured manifest requests
app.get('/:config/manifest.json', (req, res) => {
    try {
        const config = JSON.parse(decodeURIComponent(req.params.config));
        res.json(getManifest(config));
    } catch (e) {
        res.json(getManifest());
    }
});

// Handle stream requests with config
app.get('/:config/stream/:type/:id.json', async (req, res) => {
    try {
        const config = JSON.parse(decodeURIComponent(req.params.config));
        const builder = createAddon(config);
        const result = await builder.getInterface().stream.handler({
            type: req.params.type,
            id: req.params.id.replace('.json', '')
        });
        res.json(result);
    } catch (error) {
        console.error('Stream error:', error);
        res.json({ streams: [] });
    }
});

// Fallback routes for unconfigured addon
app.get('/manifest.json', (req, res) => {
    res.json(getManifest());
});

const PORT = process.env.PORT || 7000;

app.listen(PORT, () => {
    console.log(`
╔════════════════════════════════════════════════════════════╗
║           German Dub Stremio Addon (s.to)                  ║
╠════════════════════════════════════════════════════════════╣
║  Configuration Page: http://localhost:${PORT}                 ║
║                                                            ║
║  To install:                                               ║
║  1. Open http://localhost:${PORT} in your browser             ║
║  2. Enter your Real-Debrid API key                         ║
║  3. Click "Install Addon"                                  ║
╚════════════════════════════════════════════════════════════╝
    `);
});
