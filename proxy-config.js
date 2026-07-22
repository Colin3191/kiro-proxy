import { setGlobalDispatcher, EnvHttpProxyAgent } from 'undici';

export function getProxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy ||
         process.env.HTTP_PROXY || process.env.http_proxy || '';
}

export function initGlobalProxy() {
  const proxyUrl = getProxyUrl();
  if (proxyUrl) {
    setGlobalDispatcher(new EnvHttpProxyAgent());
  }
  return proxyUrl;
}
