const TRUSTED_ENDPOINTS = Object.freeze({
  tikhubBaseUrl: 'https://api.tikhub.dev',
  dashscopeBaseUrl: 'https://dashscope.aliyuncs.com/api/v1',
  deepseekBaseUrl: 'https://api.deepseek.com'
});

function normalizeBaseUrl(value) {
  return String(value || '').trim().replace(/\/$/, '');
}

function isTrustedEndpoint(name, value) {
  try {
    const actual = new URL(normalizeBaseUrl(value));
    const expected = new URL(TRUSTED_ENDPOINTS[name]);
    return actual.protocol === 'https:' && actual.hostname === expected.hostname;
  } catch {
    return false;
  }
}

function validateEndpoint(name, value, consent = false) {
  const normalized = normalizeBaseUrl(value);
  let url;
  try { url = new URL(normalized); } catch { throw new Error('接口地址格式不正确'); }
  if (url.protocol !== 'https:') throw new Error('接口地址必须使用 HTTPS');
  if (!isTrustedEndpoint(name, normalized) && !consent) {
    throw new Error('自定义接口地址会接收你的 API 密钥，请勾选风险确认后再保存');
  }
  return normalized;
}

function redactText(value, secrets = []) {
  let text = String(value ?? '');
  for (const secret of secrets.filter(Boolean)) text = text.split(String(secret)).join('[已隐藏]');
  return text
    .replace(/Bearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [已隐藏]')
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|key)=)[^&#\s]+/gi, '$1[已隐藏]')
    .replace(/("?(?:authorization|api[_-]?key|access[_-]?token)"?\s*[:=]\s*"?)[^",\s}]+/gi, '$1[已隐藏]')
    .replace(/(https?:\/\/[^\s?"']+)\?[^\s"']+/gi, '$1?[参数已隐藏]');
}

module.exports = { TRUSTED_ENDPOINTS, isTrustedEndpoint, normalizeBaseUrl, redactText, validateEndpoint };
