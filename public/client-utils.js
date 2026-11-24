export function el(tag, className, text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

export function setMessage(node, value, baseClass, type = '') {
  node.textContent = value;
  node.className = type ? `${baseClass} ${type}` : baseClass;
}

export async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const contentType = String(response.headers.get('content-type') || '').toLowerCase();
  let body = null;
  let text = '';
  if (contentType.includes('application/json')) {
    body = await response.json();
  } else {
    text = (await response.text()).trim();
  }
  if (!response.ok) {
    const error = new Error(body?.error || text || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  if (body === null) {
    throw new Error('Server returned an unexpected non-JSON response.');
  }
  return body;
}
