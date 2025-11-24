export default async function handler(req, res) {
  // CORS headers for Janitor AI (mobile + web)
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, User-Agent, X-Janitor-Client',
    'Access-Control-Max-Age': '86400',
  };

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).setHeader('Access-Control-Allow-Origin', '*').end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    
    // Detect Janitor AI client type
    const userAgent = req.headers['user-agent'] || '';
    const janitorClient = req.headers['x-janitor-client'] || '';
    const isMobile = userAgent.includes('Mobile') || janitorClient.toLowerCase().includes('mobile');
    
    // Get NVIDIA API credentials
    const apiKey = process.env.NVIDIA_API_KEY;
    const apiBase = 'https://integrate.api.nvidia.com/v1';
    
    if (!apiKey) {
      return res.status(500).json({ 
        error: { 
          message: 'NVIDIA_API_KEY not configured', 
          type: 'configuration_error' 
        } 
      });
    }
    
    // Forward the request body as-is (OpenAI compatible)
    const payload = body;
    
    // Make request with timeout
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000); // 120s timeout
    
    try {
      const response = await fetch(`${apiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      
      clearTimeout(timeout);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        return res.status(response.status).json({
          error: {
            message: errorData.error?.message || 'API request failed',
            type: 'api_error',
            code: response.status,
          }
        });
      }
      
      // Detect if streaming from request body
      const stream = payload.stream !== false;
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        Object.entries(corsHeaders).forEach(([key, value]) => {
          res.setHeader(key, value);
        });
        
        // Stream the response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            res.write(chunk);
          }
          
          res.end();
        } catch (streamError) {
          console.error('Stream error:', streamError);
          res.write(`data: ${JSON.stringify({
            error: {
              message: 'Stream interrupted',
              type: 'stream_error'
            }
          })}\n\n`);
          res.end();
        }
      } else {
        // Non-streaming response
        const data = await response.json();
        Object.entries(corsHeaders).forEach(([key, value]) => {
          res.setHeader(key, value);
        });
        res.status(200).json(data);
      }
      
    } catch (fetchError) {
      clearTimeout(timeout);
      
      if (fetchError.name === 'AbortError') {
        return res.status(504).json({
          error: {
            message: 'Request timed out after 120 seconds',
            type: 'timeout_error',
            code: 'timeout'
          }
        });
      }
      
      throw fetchError;
    }
    
  } catch (error) {
    console.error('Proxy error:', error);
    
    Object.entries(corsHeaders).forEach(([key, value]) => {
      res.setHeader(key, value);
    });
    
    return res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'internal_error',
      }
    });
  }
}
