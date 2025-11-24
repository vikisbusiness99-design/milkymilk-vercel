// ============================================
// FILE: api/index.js
// ============================================

export default async function handler(req, res) {
  console.log('=== Request received ===');
  console.log('Method:', req.method);
  console.log('URL:', req.url);
  console.log('Headers:', req.headers);
  
  // CORS headers for Janitor AI (mobile + web)
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key, User-Agent, X-Janitor-Client',
    'Access-Control-Max-Age': '86400',
  };

  // Apply CORS headers to all responses
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  // Only allow POST
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    console.log('Request body:', JSON.stringify(body, null, 2));
    
    // Detect Janitor AI client type
    const userAgent = req.headers['user-agent'] || '';
    const janitorClient = req.headers['x-janitor-client'] || '';
    const isMobile = userAgent.includes('Mobile') || janitorClient.toLowerCase().includes('mobile');
    
    console.log('Is mobile client:', isMobile);
    
    // Get NVIDIA API credentials
    const apiKey = process.env.NVIDIA_API_KEY;
    const apiBase = 'https://integrate.api.nvidia.com/v1';
    
    console.log('API Base:', apiBase);
    console.log('API Key exists:', !!apiKey);
    
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
    
    console.log('Forwarding to NVIDIA NIM...');
    console.log('Payload:', JSON.stringify(payload, null, 2));
    
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
      
      console.log('NVIDIA response status:', response.status);
      
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        console.error('NVIDIA error:', errorData);
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
      
      // Handle streaming response
      if (stream) {
        console.log('Streaming response...');
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        
        // Stream the response
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              console.log('Stream completed');
              break;
            }
            
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
        console.log('Non-streaming response');
        const data = await response.json();
        res.status(200).json(data);
      }
      
    } catch (fetchError) {
      clearTimeout(timeout);
      
      if (fetchError.name === 'AbortError') {
        console.error('Request timeout');
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
    
    return res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'internal_error',
      }
    });
  }
}
