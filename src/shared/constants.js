/* MockPanel 全局常量定义 */

export const CH_PAGE = 'mock-panel:page';
export const CH_EXT = 'mock-panel:ext';

export const K_ENABLED = 'mockPanel.enabled';
export const K_RULE_IDS = 'mockPanel.ruleIds';

export const P_RULE = 'rule:';
export const P_RULE_BODY = 'rulebody:';

export const PORT_PANEL = 'mock-panel-ui';
export const SCHEMA_VERSION = 1;

export const MAX_CAPTURE_PER_TAB = 100;
export const MAX_BODY_CHARS = 2 * 1024 * 1024;

export const METHODS = ['ANY', 'GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
export const URL_OPS = ['contains', 'equals', 'wildcard', 'regex'];
export const COND_SOURCES = ['query', 'header', 'body'];
export const COND_OPS = ['equals', 'notEquals', 'contains', 'exists', 'regex'];

export const STATUS_PRESETS = [200, 201, 204, 400, 401, 403, 404, 422, 429, 500, 502, 503];

export const STATUS_TEXT = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  413: 'Payload Too Large',
  415: 'Unsupported Media Type',
  422: 'Unprocessable Content',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout'
};

export const NULL_BODY_STATUSES = new Set([204, 205, 304]);

export const CONTENT_TYPES = [
  'application/json;charset=utf-8',
  'text/plain;charset=utf-8',
  'text/html;charset=utf-8',
  'application/xml;charset=utf-8'
];
