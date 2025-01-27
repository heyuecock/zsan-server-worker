// 常量定义
const RATE_LIMIT = {
    WINDOW_SIZE: 60, // 60秒窗口
    MAX_REQUESTS: 100 // 每个窗口最大请求数
};

const ERROR_MESSAGES = {
    RATE_LIMIT: '请求过于频繁，请稍后再试',
    INVALID_DATA: '无效的数据格式',
    DB_ERROR: '数据库操作失败',
    NOT_FOUND: '资源未找到',
    SERVER_ERROR: '服务器内部错误'
};

// 在常量定义部分添加数据保留时间配置
const DATA_RETENTION = {
    MAX_RECORDS_PER_CLIENT: 10  // 每个客户端保留的最大记录数
};

// 添加 GitHub index.html 链接常量
const INDEX_HTML_URL = 'https://raw.githubusercontent.com/heyuecock/zsan/refs/heads/main/index.html';

// 添加缓存对象
let indexHtmlCache = {
    content: null,
    timestamp: 0
};

// 修改国家代码映射
const COUNTRY_CODE_MAP = {
    'hk': 'cn',  // 香港映射到中国
    'mo': 'cn',  // 澳门映射到中国
    'tw': 'cn',  // 台湾映射到中国
    'xx': 'xx'   // 未知地区
};

// 工具函数
const utils = {
    validateMetrics: (data) => {
        const required = ['machine_id', 'name', 'system', 'uptime'];
        return required.every(field => data.has(field));
    },

    sanitizeString: (str) => {
        if (!str) return '';
        return str.replace(/[<>]/g, '').slice(0, 255);
    },

    formatResponse: (success, data, error = null) => {
        return {
            success,
            timestamp: Date.now(),
            data: data || null,
            error: error || null
        };
    },

    handleError: (error, status = 500) => {
        console.error('Error:', error);
        return new Response(
            JSON.stringify(utils.formatResponse(false, null, error.message || ERROR_MESSAGES.SERVER_ERROR)),
            {
                status,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                }
            }
        );
    },

    async cleanupOldData(env) {
        try {
            // 添加时间限制
            const cutoffTime = Math.floor(Date.now() / 1000) - (7 * 24 * 60 * 60); // 7天
            
            // 删除旧数据
            await env.DB
                .prepare(`
                    DELETE FROM status 
                    WHERE insert_utc_ts < ? 
                    AND id NOT IN (
                        SELECT id
                        FROM (
                            SELECT id
                            FROM status
                            WHERE client_id = status.client_id
                            ORDER BY insert_utc_ts DESC
                            LIMIT ?
                        )
                    )
                `)
                .bind(cutoffTime, DATA_RETENTION.MAX_RECORDS_PER_CLIENT)
                .run();

            // 删除没有关联状态数据的客户端
            await env.DB
                .prepare(`
                    DELETE FROM client 
                    WHERE id NOT IN (
                        SELECT DISTINCT client_id 
                        FROM status
                    )
                `)
                .run();

            console.log(`Cleaned up old data, keeping ${DATA_RETENTION.MAX_RECORDS_PER_CLIENT} latest records per client`);
        } catch (error) {
            console.error('Error cleaning up old data:', error);
        }
    }
};

// 速率限制中间件
class RateLimiter {
    constructor() {
        this.requests = new Map();
    }

    async checkLimit(request) {
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const now = Date.now();
        const windowStart = now - (RATE_LIMIT.WINDOW_SIZE * 1000);

        // 清理过期的请求记录
        if (this.requests.has(ip)) {
            this.requests.get(ip).timestamps = this.requests.get(ip).timestamps.filter(
                time => time > windowStart
            );
        }

        // 获取或初始化请求记录
        const record = this.requests.get(ip) || { timestamps: [] };
        
        // 检查是否超过限制
        if (record.timestamps.length >= RATE_LIMIT.MAX_REQUESTS) {
            return false;
        }

        // 记录新的请求
        record.timestamps.push(now);
        this.requests.set(ip, record);
        return true;
    }
}

const rateLimiter = new RateLimiter();

// 修改 getLocationInfo 函数
async function getLocationInfo(request) {
    try {
        // 获取 IP 地址的地理位置信息
        const ipAddress = request.headers.get('CF-Connecting-IP');
        const rawCountryCode = (request.cf?.country || 'xx').toLowerCase();
        
        // 特殊处理中国地区
        let mappedCountryCode = COUNTRY_CODE_MAP[rawCountryCode] || rawCountryCode;
        
        // 如果是中国的特别行政区，统一显示为中国
        if (rawCountryCode === 'hk' || rawCountryCode === 'mo' || rawCountryCode === 'tw') {
            mappedCountryCode = 'cn';
        }
        
        const locationInfo = {
            country: request.cf?.country || 'Unknown',
            city: request.cf?.city || 'Unknown',
            continent: request.cf?.continent || 'Unknown',
            latitude: request.cf?.latitude || 0,
            longitude: request.cf?.longitude || 0,
            country_code: mappedCountryCode
        };
        
        console.log('Location info:', locationInfo);
        return locationInfo;
    } catch (error) {
        console.error('Error getting location info:', error);
        return {
            country_code: 'cn'  // 默认返回中国
        };
    }
}

// 路由处理函数
const routeHandlers = {
    async handlePostStatus(request, env) {
        try {
            // 检查 env.DB 是否存在
            if (!env.DB) {
                console.error('Database binding not found');
                return utils.handleError(new Error('数据库未配置'), 500);
            }

            // 速率限制检查
            if (!await rateLimiter.checkLimit(request)) {
                return utils.handleError(new Error(ERROR_MESSAGES.RATE_LIMIT), 429);
            }

            const formData = await request.formData();
            
            // 数据验证
            if (!utils.validateMetrics(formData)) {
                return utils.handleError(new Error(ERROR_MESSAGES.INVALID_DATA), 400);
            }

            // 清理和验证数据
            const machineId = utils.sanitizeString(formData.get('machine_id'));
            const name = utils.sanitizeString(formData.get('name')) || '未命名';
            const system = utils.sanitizeString(formData.get('system')) || '';
            const location = utils.sanitizeString(formData.get('location')) || '未知';
            const ipAddress = formData.get('ip_address');

            // 获取地理位置信息
            const locationInfo = await getLocationInfo(request);

            // 在 handlePostStatus 中添加日志
            console.log('Location info:', locationInfo);
            console.log('Inserting status with country_code:', locationInfo?.country_code);

            // 数据库操作
            let clientId;
            let { results } = await env.DB
                .prepare('SELECT id FROM client WHERE machine_id = ?')
                .bind(machineId)
                .run();

            if (results && results[0]) {
                clientId = results[0].id;
                await env.DB
                    .prepare('UPDATE client SET name = ? WHERE id = ?')
                    .bind(name, clientId)
                    .run();
            } else {
                const { meta } = await env.DB
                    .prepare('INSERT INTO client (machine_id, name) VALUES (?, ?)')
                    .bind(machineId, name)
                    .run();
                clientId = meta.last_row_id;
            }

            // 插入状态数据
            await env.DB
                .prepare(`
                    INSERT INTO status (
                        client_id, name, system, location, insert_utc_ts,
                        uptime, cpu_percent, net_tx, net_rx, disks_total_kb,
                        disks_avail_kb, cpu_num_cores, mem_total, mem_free,
                        mem_used, swap_total, swap_free, process_count,
                        connection_count, ip_address, country_code
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `)
                .bind(
                    clientId,
                    name,
                    system,
                    location,
                    Math.floor(Date.now() / 1000),
                    parseInt(formData.get('uptime')) || 0,
                    parseFloat(formData.get('cpu_percent')) || 0,
                    parseInt(formData.get('net_tx')) || 0,
                    parseInt(formData.get('net_rx')) || 0,
                    parseInt(formData.get('disks_total_kb')) || 0,
                    parseInt(formData.get('disks_avail_kb')) || 0,
                    parseInt(formData.get('cpu_num_cores')) || 0,
                    parseFloat(formData.get('mem_total')) || 0,
                    parseFloat(formData.get('mem_free')) || 0,
                    parseFloat(formData.get('mem_used')) || 0,
                    parseFloat(formData.get('swap_total')) || 0,
                    parseFloat(formData.get('swap_free')) || 0,
                    parseInt(formData.get('process_count')) || 0,
                    parseInt(formData.get('connection_count')) || 0,
                    ipAddress,
                    locationInfo?.country_code || 'xx'
                )
                .run();

            // 每次插入数据后都执行清理
            await utils.cleanupOldData(env);

            return new Response(
                JSON.stringify(utils.formatResponse(true, {
                    client_id: clientId,
                    name: name,
                    location: location
                })),
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*'
                    }
                }
            );
        } catch (error) {
            console.error('Error in handlePostStatus:', error);
            return utils.handleError(error);
        }
    },

    async handleGetLatestStatus(request, env) {
        try {
            if (!env.DB) {
                console.error('Database binding not found');
                return utils.handleError(new Error('数据库未配置'), 500);
            }

            if (!await rateLimiter.checkLimit(request)) {
                return utils.handleError(new Error(ERROR_MESSAGES.RATE_LIMIT), 429);
            }

            const { results } = await env.DB
                .prepare(`
                    SELECT 
                        c.machine_id,
                        s.*
                    FROM status s
                    JOIN client c ON s.client_id = c.id
                    WHERE s.id IN (
                        SELECT MAX(id)
                        FROM status
                        GROUP BY client_id
                    )
                    ORDER BY s.insert_utc_ts DESC
                `)
                .run();

            // 在 handleGetLatestStatus 中添加日志
            console.log('Retrieved results:', results);

            // 处理结果，计算负载值并确保所有字段存在
            const processedResults = (results || []).map(server => {
                return {
                    ...server,
                    // 确保所有必要字段存在且有合理的默认值
                    name: server.name || '未命名',
                    location: server.location || '未知',
                    system: server.system || 'Unknown',
                    uptime: parseInt(server.uptime) || 0,
                    cpu_percent: parseFloat(server.cpu_percent) || 0,
                    net_tx: parseInt(server.net_tx) || 0,
                    net_rx: parseInt(server.net_rx) || 0,
                    disks_total_kb: parseInt(server.disks_total_kb) || 0,
                    disks_avail_kb: parseInt(server.disks_avail_kb) || 0,
                    cpu_num_cores: parseInt(server.cpu_num_cores) || 1,
                    mem_total: parseFloat(server.mem_total) || 0,
                    mem_free: parseFloat(server.mem_free) || 0,
                    mem_used: parseFloat(server.mem_used) || 0,
                    swap_total: parseFloat(server.swap_total) || 0,
                    swap_free: parseFloat(server.swap_free) || 0,
                    process_count: parseInt(server.process_count) || 0,
                    connection_count: parseInt(server.connection_count) || 0,
                    country_code: server.country_code || 'xx',
                    cpu_model: server.cpu_model || 'Unknown CPU'
                };
            });

            return new Response(
                JSON.stringify(utils.formatResponse(true, processedResults)),
                {
                    headers: {
                        'Content-Type': 'application/json',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'no-cache'
                    }
                }
            );
        } catch (error) {
            console.error('Error in handleGetLatestStatus:', error);
            return utils.handleError(error);
        }
    },

    async handleGetIndex(request, env) {
        try {
            const CACHE_TTL = 3600; // 缓存1小时
            const now = Date.now() / 1000;

            // 检查缓存是否有效
            if (indexHtmlCache.content && (now - indexHtmlCache.timestamp) < CACHE_TTL) {
                return new Response(indexHtmlCache.content, {
                    headers: {
                        'Content-Type': 'text/html',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'public, max-age=3600'
                    }
                });
            }

            // 从 GitHub 获取最新内容
            const response = await fetch(INDEX_HTML_URL, {
                cf: {
                    cacheTtl: CACHE_TTL,
                    cacheEverything: true
                }
            });

            if (!response.ok) {
                throw new Error(`Failed to fetch index.html: ${response.status}`);
            }

            const content = await response.text();

            // 更新缓存
            indexHtmlCache = {
                content,
                timestamp: now
            };

            return new Response(content, {
                headers: {
                    'Content-Type': 'text/html',
                    'Access-Control-Allow-Origin': '*',
                    'Cache-Control': 'public, max-age=3600'
                }
            });
        } catch (error) {
            console.error('Error in handleGetIndex:', error);
            
            // 如果有缓存内容,在出错时返回缓存
            if (indexHtmlCache.content) {
                return new Response(indexHtmlCache.content, {
                    headers: {
                        'Content-Type': 'text/html',
                        'Access-Control-Allow-Origin': '*',
                        'Cache-Control': 'public, max-age=3600'
                    }
                });
            }
            
            return utils.handleError(error);
        }
    },

    async handleGetStatus(request) {
        return new Response('zsan', {  // 修改返回值为 'zsan'
            headers: { 
                'Content-Type': 'text/plain',
                'Cache-Control': 'no-cache'
            },
        });
    },

    async handleOptions(request) {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
                'Access-Control-Max-Age': '86400'
            }
        });
    }
};

// 主导出
export default {
    async fetch(request, env) {
        try {
            // 添加调试日志
            console.log('Request URL:', request.url);
            console.log('Request method:', request.method);
            console.log('Database binding:', env.DB ? 'present' : 'missing');

            const url = new URL(request.url);
            const path = url.pathname;
            const method = request.method;

            // 处理 OPTIONS 请求
            if (method === 'OPTIONS') {
                return routeHandlers.handleOptions(request);
            }

            // 定义路由映射
            const routes = {
                'POST /status': routeHandlers.handlePostStatus,
                'GET /status/latest': routeHandlers.handleGetLatestStatus,
                'GET /': routeHandlers.handleGetIndex,
                'GET /status': routeHandlers.handleGetStatus,
            };

            // 路由匹配
            const routeKey = `${method} ${path}`;
            const handler = routes[routeKey];

            if (handler) {
                return await handler(request, env);
            }

            console.error('Route not found:', routeKey);
            return utils.handleError(new Error(ERROR_MESSAGES.NOT_FOUND), 404);
        } catch (error) {
            console.error('Error in fetch:', error);
            return utils.handleError(error);
        }
    }
};

