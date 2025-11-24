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
    
    // Get model and determine which API to use
    const model = body.model || 'deepseek-r1';
    const messages = body.messages || [];
    const stream = body.stream !== false; // Default to streaming
    const temperature = body.temperature || 0.7;
    const maxTokens = body.max_tokens || 2048;
    
    // Model routing
    let apiKey, apiBase, providerModel;
    
    if (model.includes('longcat')) {
      apiKey = process.env.LONGCAT_API_KEY;
      apiBase = 'https://api.longcat.chat/openai/v1';
      providerModel = model.includes('thinking') ? 'LongCat-Flash-Thinking' : 'LongCat-Flash-Chat';
    } else {
      // Default to NVIDIA NIM
      apiKey = process.env.NVIDIA_API_KEY;
      apiBase = 'https://integrate.api.nvidia.com/v1';
      
      // Map model names to NVIDIA NIM format
      const modelMap = {
        'deepseek-r1': 'deepseek-ai/deepseek-r1',
        'deepseek-r1-0528': 'deepseek-ai/deepseek-r1-0528',
        'deepseek-3.1': 'deepseek-ai/deepseek-v3.1',
        'deepseek-terminus': 'deepseek-ai/deepseek-v3.1-terminus',
        'kimi-instruct': 'moonshotai/kimi-k2-instruct-0905',
        'mistral-nemotron': 'mistralai/mistral-nemotron',
        'qwen3-next': 'qwen/qwen3-next-80b-a3b-thinking',
        'nvidia-nemotron': 'nvidia/llama-3.1-nemotron-ultra-253b-v1',
      };
      
      providerModel = modelMap[model] || model;
    }
    
    if (!apiKey) {
      return res.status(500).json({ 
        error: { 
          message: 'API key not configured', 
          type: 'configuration_error' 
        } 
      });
    }
    
    // Prepare request payload
    const payload = {
      model: providerModel,
      messages: messages,
      temperature: temperature,
      max_tokens: maxTokens,
      stream: stream,
    };
    
    // Add extra parameters for reasoning models
    if (model === 'deepseek-terminus') {
      payload.chat_template_kwargs = { thinking: true };
    }
    
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
      
      // Handle streaming response
      if (stream) {
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
