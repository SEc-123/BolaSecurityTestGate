/** Normalize only supplied/observed credentials. Never create a test identity. */
export function identityMaterial(input: Record<string, any> = {}): Record<string, any> {
    const fields = { ...input };
    const token = fields.auth_token || fields.authorization || fields.Authorization || fields.access_token || fields.token || fields.jwt;
    delete fields.auth_token;
    if (typeof token === 'string' && token.trim() && !/[\r\n]/.test(token))
        fields.auth_token = /^[A-Za-z][A-Za-z0-9_-]*\s/.test(token) ? token : `Bearer ${token}`;
    const cookies: Record<string, string> = {};
    const raw = fields.cookie_header || fields.cookie || fields.Cookie;
    delete fields.cookie_header;
    delete fields.cookies;
    delete fields.credentials;
    if (typeof raw === 'string')
        for (const part of raw.split(';')) {
            const at = part.indexOf('=');
            if (at > 0)
                cookies[part.slice(0, at).trim()] = part.slice(at + 1).trim();
        }
    if (input.cookies && typeof input.cookies === 'object' && !Array.isArray(input.cookies))
        for (const [name, value] of Object.entries(input.cookies)) {
            if (['string', 'number', 'boolean'].includes(typeof value))
                cookies[name] = String(value);
        }
    for (const [name, value] of Object.entries(cookies))
        if (!name || /[\r\n;=]/.test(name) || /[\r\n;]/.test(value))
            delete cookies[name];
    if (Object.keys(cookies).length) {
        fields.cookies = cookies;
        fields.cookie_header = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }
    if (fields.auth_token || fields.cookie_header)
        fields.credentials = { ...(fields.auth_token ? { authorization: fields.auth_token } : {}), ...(fields.cookie_header ? { cookie: fields.cookie_header } : {}) };
    if (!fields.object_id)
        fields.object_id = fields.order_id || fields.file_id;
    return fields;
}
export function identityHeaders(fields: Record<string, any>): Record<string, string> {
    const actual = identityMaterial(fields);
    return { ...(actual.auth_token ? { authorization: actual.auth_token } : {}), ...(actual.cookie_header ? { cookie: actual.cookie_header } : {}) };
}
