// ==UserScript==
// @name         B站营销号过滤
// @namespace    MnFeN
// @version      1.0.0
// @description  从 B 站推荐视频中过滤营销号，支持自定义筛选逻辑、设置 UP 主及关键词黑白名单
// @author       MnFeN
// @homepageURL  https://github.com/MnFeN/Bilibili-Clickbait-Filter
// @supportURL   https://github.com/MnFeN/Bilibili-Clickbait-Filter/issues
// @updateURL    https://raw.githubusercontent.com/MnFeN/Bilibili-Clickbait-Filter/main/Bilibili-Clickbait-Filter.user.js
// @downloadURL  https://raw.githubusercontent.com/MnFeN/Bilibili-Clickbait-Filter/main/Bilibili-Clickbait-Filter.user.js
// @match        https://www.bilibili.com/*
// @match        https://space.bilibili.com/*
// @noframes
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      api.bilibili.com
// ==/UserScript==

/*
 * API 使用与实测备注（2026-09-25；耗时会随网络、账号与 B 站服务状态波动）：
 *
 * 1. /x/web-interface/nav
 *    用途：取得 WBI 签名密钥。
 *    单线程响应约 250 ms；调用频率很低，脚本内会缓存签名密钥。
 *
 * 2. /x/space/wbi/arc/search
 *    用途：取得 UP 主最近投稿，判断投稿频率、隐藏投稿、转载等。
 *    单线程响应约 800 ms（浮动较大），是当前主要耗时接口。
 *
 * 3. /x/web-interface/view
 *    用途：主动访问视频页时取得视频、UP 主及播放量等详情。
 *    单线程响应约 470 ms；首页/相关推荐优先直接读取 DOM，避免额外调用。
 *
 * 4. /x/space/wbi/acc/info
 *    用途：取得 UP 主完整资料；当前用于“我关注的 UP 主”、官方认证、
 *          专业/机构认证、年度大会员等放行判据。
 *    单线程响应约 300 ms。
 *    实测连续高频请求约 100 次后可能触发 code -352（风控校验失败）；
 *    与 card 的风控计数互不影响，通常等待数分钟后恢复，阈值和恢复时间并非固定。
 *
 * 5. /x/web-interface/card
 *    用途：取得 UP 主名称及粉丝数。
 *    单线程响应约 270 ms。
 *    实测连续高频请求约 100 次后可能触发 code -352；
 *    与 acc/info 的风控计数互不影响，通常等待数分钟后恢复，阈值和恢复时间并非固定。
 *
 * 调度：
 * - 全局请求默认最多并发 2 个。实测超过 2 个并发时吞吐提升很小，主要增加单请求延迟。
 * - 当前正在浏览的 UP 主、当前视口内的视频卡片优先；
 *   屏幕外卡片降低优先级；已经进入最终放行判断的 acc/info / card 请求会适当提权。
 */

(function () {
    'use strict';

    const CONFIG_KEY = 'MnFeN.config';
    const API = 'https://api.bilibili.com';

    const DEFAULTS = {
        filterHome: true,
        filterRelated: true,
        promptWhitelist: true,

        frequency: { enabled: true, count: 10, hours: 120 },
        hidden: { enabled: true, count: 3 },

        allowRepost: true,
        allowFollowing: true,
        allowOfficial: true,
        allowAttestation: true,
        allowAnnualVip: false,
        views: { enabled: false, count: 1000000 },
        followers: { enabled: true, count: 1000000 },

        concurrency: 2,
        debug: false,

        uploaders: [],
        keywords: []
    };

    // 按设置页页码、同页从上到下排列。
    const FIELDS = [
        // 过滤规则页：通用
        {
            key: 'filterHome',
            group: 'general',
            text: '过滤首页推荐',
            help: '筛选 B 站首页推荐，包括换一换和滚动加载的视频。'
        },
        {
            key: 'filterRelated',
            group: 'general',
            text: '过滤视频页右侧推荐',
            help: '筛选 B 站视频页右侧的相关视频推荐。'
        },
        {
            key: 'promptWhitelist',
            group: 'general',
            text: '访问被屏蔽的 UP 主时询问加入白名单',
            help: '由于脚本逻辑可能存在误伤，主动打开视频或个人主页时做出相应补救：\n如果屏蔽规则检查到你正在浏览的 UP 主被判断为营销号，弹窗询问是否加入白名单。'
        },

        // 过滤规则页：屏蔽
        {
            key: 'frequency',
            group: 'block',
            text: '最新 {count} 条投稿跨度小于 {hours} 小时',
            inputs: { count: [2, 10], hours: [1] },
            help: '若最新几条投稿的发布时间间隔过短，则很可能是使用脚本批量生产视频的营销号。'
        },
        {
            key: 'hidden',
            group: 'block',
            text: '不足上述条数时，当前视频被隐藏且可见投稿少于 {count} 条',
            inputs: { count: [1, 10] },
            help: '有一部分营销号会将视频设置为主页不可见，规避限流等风险。\n此规则用于筛除这部分账号，关闭前面的跨度规则不影响本行。'
        },

        // 过滤规则页：放行
        {
            key: 'allowRepost',
            group: 'allow',
            text: '查询到的投稿包含转载',
            help: '屏蔽规则可能误伤大量规范转载搬运视频的账号，\n而营销号为了收益都会将转载的内容标为自制。\n\n若查询到该 UP 主的投稿列表中有转载视频，\n则判定为非营销号，跳过其他判据。'
        },
        {
            key: 'allowFollowing',
            group: 'allow',
            text: '我关注的 UP 主',
            help: '若当前登录账号已经关注该 UP 主，则放行。'
        },
        {
            key: 'allowOfficial',
            group: 'allow',
            text: '官方认证账号',
            help: '若账号具有有效的 B 站官方认证，则放行。\n例：知名创作者、某领域认证账号、某网站官方账号。\n\n由于 B 站 API 对此项查询频率的限制较严格，\n仅在由其他判据判断应屏蔽此视频后查询此项。\n如果看到了弹窗提示 API 请求遇到风控，可以关闭这一选项。'
        },
        {
            key: 'allowAttestation',
            group: 'allow',
            text: '专业/机构认证账号',
            help: '若账号具有专业或机构认证，则放行。\n例：bilibili 机构认证-媒体。\n\n由于 B 站 API 对此项查询频率的限制较严格，\n仅在由其他判据判断应屏蔽此视频后查询此项。\n如果看到了弹窗提示 API 请求遇到风控，可以关闭这一选项。'
        },
        {
            key: 'allowAnnualVip',
            group: 'allow',
            text: '开通年度大会员',
            help: '若账号当前为有效的年度大会员，则放行。\n实测很多营销号同样会开启年度大会员，因此区分度有限，不建议开启。\n\n由于 B 站 API 对此项查询频率的限制较严格，\n仅在由其他判据判断应屏蔽此视频后查询此项。\n如果看到了弹窗提示 API 请求遇到风控，可以关闭这一选项。'
        },
        {
            key: 'views',
            group: 'allow',
            text: '当前视频播放量不低于 {count}',
            inputs: { count: [0] },
            help: '若播放量较高，则判断该视频有一定价值，考虑放行当前视频。'
        },
        {
            key: 'followers',
            group: 'allow',
            text: 'UP 主粉丝数高于 {count}',
            inputs: { count: [0] },
            help: '若 UP 主粉丝量较高，则判断该视频有一定价值，考虑放行当前视频。\n\n由于 B 站 API 对粉丝数查询频率的限制较严格，\n仅在由其他判据判断应屏蔽此视频后查询此项。\n如果看到了弹窗提示 API 请求遇到风控，可以关闭这一选项。'
        },

        // 高级页
        {
            key: 'concurrency',
            group: 'advanced',
            text: '最多同时请求 {value} 个接口',
            inputs: { value: [1] },
            help: '所有接口共用此并发上限。\n默认 2；实测继续提高并发通常不会明显增加吞吐量，反而会拖慢单个请求。'
        },
        {
            key: 'debug',
            group: 'advanced',
            text: '调试模式',
            help: '开启时标题标红并在前方显示原因，而不隐藏视频卡片；\n此外每次接口受限时均弹窗，而非仅显示一次。'
        }
    ];

    const SCOPE_LABELS = {
        title: '标题',
        id: 'UP 主名称',
        all: 'UP 主名称+标题'
    };

    const HOME = {
        cards: '.bili-video-card',
        title: '.bili-video-card__info--tit > a',
        link: '.bili-video-card__info--tit > a',
        owner: 'a[href*="space.bilibili.com/"]',
        name: '.bili-video-card__info--author',
        play: '.bili-video-card__stats--left > .bili-video-card__stats--item:first-child > .bili-video-card__stats--text'
    };

    const RELATED = {
        cards: '.recommend-list-v1 > .rec-list > .video-page-card-small',
        title: ':scope > .card-box > .info > a > .title',
        link: ':scope > .card-box > .info > a',
        owner: ':scope > .card-box > .info > .upname > a',
        name: ':scope > .card-box > .info > .upname > a > .name',
        play: ':scope > .card-box > .info > .playinfo > svg.play'
    };

    const config = loadConfig();
    const keywords = config.keywords.map(rule => ({
        ...rule,
        regex: parseRegex(rule.pattern)
    }));

    const PRIORITY = {
        HIGH: 0,
        NORMAL: 1,
        LOW: 2
    };

    const queue = [];
    const uploads = new Map();
    const uploaderCards = new Map();
    const uploaderInfos = new Map();
    const details = new Map();
    const decisions = new Map();
    const marked = new Map();
    const promptedUploaders = new Set();

    let queueSequence = 0;
    let active = 0;
    let updateTimer;
    let started = false;
    let riskAlerted = false;
    let settingsHost = null;
    let lastRoute = '';
    let routeVersion = 0;
    let keyPromise;

    GM_registerMenuCommand('营销号过滤设置', openSettings);

    if (getPage().type) prepareKey();

    function prepareKey() {
        if (!keyPromise) {
            keyPromise = getSigningKey().catch(error => {
                console.warn('[MnFeN]', error.message);
                return null;
            });
        }
        return keyPromise;
    }

    function sortRules(items, key) {
        items.sort((a, b) =>
            Number(a.list === 'black') - Number(b.list === 'black') ||
            (a[key] || '').localeCompare(b[key] || '', 'zh-CN') ||
            (a.uid || a.scope || '').localeCompare(b.uid || b.scope || '', 'zh-CN')
        );
    }

    function loadConfig() {
        const saved = GM_getValue(CONFIG_KEY, {});
        const result = structuredClone(DEFAULTS);

        if (!saved || typeof saved !== 'object') return result;

        for (const field of FIELDS) {
            const base = DEFAULTS[field.key];
            const value = saved[field.key];

            if (typeof base === 'boolean') {
                if (typeof value === 'boolean') result[field.key] = value;
                continue;
            }

            if (typeof base === 'object' && typeof value?.enabled === 'boolean')
                result[field.key].enabled = value.enabled;

            for (const [key, [min, max = Number.MAX_SAFE_INTEGER]] of Object.entries(field.inputs)) {
                const number = key === 'value' ? value : value?.[key];

                if (Number.isSafeInteger(number) && number >= min && number <= max) {
                    if (key === 'value') result[field.key] = number;
                    else result[field.key][key] = number;
                }
            }
        }

        const users = new Map();

        for (const item of Array.isArray(saved.uploaders) ? saved.uploaders : []) {
            if (!item ||
                !/^[1-9]\d*$/.test(String(item.uid)) ||
                !['white', 'black'].includes(item.list)) continue;

            users.set(String(item.uid), {
                uid: String(item.uid),
                name: typeof item.name === 'string' ? item.name.trim() : '',
                list: item.list
            });
        }

        result.uploaders = [...users.values()];

        result.keywords = (Array.isArray(saved.keywords) ? saved.keywords : [])
            .filter(item => {
                if (!item ||
                    typeof item.pattern !== 'string' ||
                    !['white', 'black'].includes(item.list) ||
                    !Object.hasOwn(SCOPE_LABELS, item.scope)) return false;

                try {
                    parseRegex(item.pattern);
                    return true;
                } catch (_) {
                    return false;
                }
            })
            .map(({ pattern, list, scope }) => ({ pattern, list, scope }));

        sortRules(result.uploaders, 'name');
        sortRules(result.keywords, 'pattern');

        return result;
    }

    function parseRegex(pattern) {
        if (!pattern.trim()) throw new Error('表达式不能为空。');

        if (/^\/[\s\S]*\/[a-z]*$/i.test(pattern))
            throw new Error('直接填写表达式，不要使用 /表达式/ 或 /表达式/i 格式。');

        return new RegExp(pattern);
    }

    function openSettings() {
        if (!document.body) {
            document.addEventListener('DOMContentLoaded', openSettings, { once: true });
            return;
        }
        if (settingsHost?.isConnected) return;

        const draft = loadConfig();
        const host = document.createElement('div');

        settingsHost = host;
        host.id = 'MnFeN-settings';
        host.style.cssText =
            'all:initial!important;position:fixed!important;inset:0!important;' +
            'z-index:2147483647!important;display:block!important';

        const root = host.attachShadow({ mode: 'open' });

        root.innerHTML = `
            <style>
                :host{font:14px/1.6 "Segoe UI","Microsoft YaHei","PingFang SC",sans-serif}
                *{box-sizing:border-box;user-select:none;-webkit-user-select:none}
                input,textarea{user-select:text;-webkit-user-select:text}
                button,input,select,table{font:inherit}
                [hidden]{display:none!important}
                .pages{display:grid}
                .pages>[data-page]{grid-area:1/1}
                .pages>[data-page][hidden]{display:block!important;visibility:hidden;pointer-events:none}
                .overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;padding:20px;background:#0007;color:#252b35;font:14px/1.6 "Segoe UI","Microsoft YaHei","PingFang SC",sans-serif}
                .panel{width:850px;max-width:100%;max-height:90vh;display:flex;flex-direction:column;background:white;border-radius:14px;overflow:hidden;box-shadow:0 16px 60px #0004}
                header,footer{display:flex;align-items:center;justify-content:space-between;padding:14px 22px;border-bottom:1px solid #e8ebef}
                h2{margin:0;font-size:18px}
                button{padding:6px 12px;border:1px solid #dbe0e6;border-radius:7px;background:white;color:#343b46;cursor:pointer}
                button:hover{background:#f3f6f9}
                button:disabled{opacity:.5;cursor:default}
                button:focus-visible,input:focus-visible,select:focus-visible,.help:focus-visible{outline:2px solid #00a1d6;outline-offset:2px}
                .close{border:0;font-size:24px;padding:0 8px}
                nav{display:flex;gap:8px;padding:12px 22px 0}
                nav button{border-color:transparent}
                nav .active{background:#eaf7fc;color:#0087b5}
                main{padding:10px 22px 20px;overflow:auto;min-height:240px}
                .row{display:flex;align-items:center;gap:9px;padding:11px 0;border-bottom:1px solid #eef0f3}
                .row.disabled{color:#a0a5ad}
                .row.disabled input{color:#a0a5ad;background:#f3f4f6}
                .row.disabled .help{color:#b4b8be;border-color:#c9cdd2}
                .sentence{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
                input[type=checkbox]{width:17px;height:17px;margin:0 3px 0 0;accent-color:#00a1d6;flex-shrink:0;cursor:pointer}
                input[type=number]{width:92px;padding:5px 7px;border:1px solid #dbe0e6;border-radius:6px}
                .help{display:inline-flex;align-items:center;justify-content:center;width:17px;height:17px;flex:0 0 auto;border:1px solid #aab3c0;border-radius:50%;color:#7b8797;font-size:12px;cursor:help}
                .heading{margin:16px 0 4px;font-weight:600}
                .black,.black a{color:#8b1e1e}
                .white,.white a{color:#176438}
                .note{color:#6b7280;margin:10px 0}
                .add{display:flex;gap:8px;flex-wrap:wrap;margin:12px 0}
                .entry{min-width:100px;flex:1;padding:7px 9px;border:1px solid #dbe0e6;border-radius:7px}
                select{padding:6px;border:1px solid #dbe0e6;border-radius:7px;background:white;color:#343b46}
                table{width:100%;border-collapse:collapse}
                th,td{padding:9px;text-align:left;border-bottom:1px solid #edf0f3;overflow-wrap:anywhere}
                th{background:#f7f9fb;font-weight:500}
                th:last-child,td:last-child{width:75px;text-align:right}
                td:first-child{white-space:pre-wrap}
                a{text-decoration:none}
                a:hover{text-decoration:underline}
                .delete{padding:3px 9px;color:#b64a4a}
                .empty{text-align:center;color:#919baa;padding:20px}
                .message{min-height:22px;margin-top:8px;color:#c44}
                footer{justify-content:flex-end;gap:9px;border-top:1px solid #e8ebef;border-bottom:0}
                .reset{margin-right:auto;color:#b64a4a}
                .primary{background:#00a1d6;border-color:#00a1d6;color:white}
                .bubble{white-space:pre-line;position:fixed;z-index:10;width:max-content;max-width:calc(100vw - 32px);padding:12px 15px;border:1px solid #c8c3a6;border-radius:12px;background:#fffceb;color:#38382f;box-shadow:0 6px 22px #0003;font:13px/1.7 "Segoe UI","Microsoft YaHei","PingFang SC",sans-serif;pointer-events:none;overflow-wrap:anywhere}
                .bubble::before{content:'';position:absolute;left:var(--arrow-left);width:12px;height:12px;background:#fffceb;transform:translateX(-50%) rotate(45deg)}
                .bubble[data-side=above]::before{bottom:-7px;border-right:1px solid #c8c3a6;border-bottom:1px solid #c8c3a6}
                .bubble[data-side=below]::before{top:-7px;border-left:1px solid #c8c3a6;border-top:1px solid #c8c3a6}
            </style>

            <div class="overlay">
                <section class="panel" role="dialog" aria-modal="true" aria-labelledby="title">
                    <header>
                        <h2 id="title">营销号过滤设置</h2>
                        <button class="close" aria-label="关闭">×</button>
                    </header>

                    <nav>
                        <button data-tab="rules" class="active">过滤规则</button>
                        <button data-tab="uploaders">UP 主</button>
                        <button data-tab="keywords">关键词</button>
                        <button data-tab="advanced">高级</button>
                    </nav>

                    <main>
                        <div class="pages">
                            <section data-page="rules">
                                <div data-group="general"></div>

                                <div class="heading black">过滤满足以下条件的视频</div>
                                <div data-group="block"></div>

                                <div class="heading white">放行满足以下条件的视频</div>
                                <div data-group="allow"></div>
                            </section>

                            <section data-page="uploaders" hidden>
                                <p class="note">按 UID 匹配，优先于关键词和自动判据。黑白名单无条件屏蔽/放行。</p>
                            </section>

                            <section data-page="keywords" hidden>
                                <p class="note">关键词优先于自动判据；关键词白名单优先于黑名单。</p>
                                <p class="note">直接填写表达式，不加 / 分隔符，如：关键词　关键词1|关键词2　^关键词$</p>
                            </section>

                            <section data-page="advanced" data-group="advanced" hidden></section>
                        </div>
                        <div class="message" role="status"></div>
                    </main>

                    <footer>
                        <button id="reset" class="reset">重置所有选项</button>
                        <button id="cancel">取消</button>
                        <button id="save" class="primary">保存并刷新</button>
                    </footer>
                </section>
            </div>

            <div id="help-bubble" class="bubble" role="tooltip" hidden></div>
        `;

        const message = root.querySelector('.message');
        const controls = [];
        const nameStatus = new Map();
        const saveButton = root.querySelector('#save');
        let adding = false;

        for (const field of FIELDS) {
            const row = document.createElement('div');
            row.className = 'row';

            const value = draft[field.key];
            const enabled = typeof value === 'boolean' ? value : value?.enabled;
            let checkbox = null;

            if (typeof enabled === 'boolean') {
                checkbox = document.createElement('input');
                checkbox.type = 'checkbox';
                checkbox.checked = enabled;
                checkbox.setAttribute('aria-label', field.text.replace(/\{(\w+)\}/g, ''));
                row.appendChild(checkbox);
            }

            const sentence = document.createElement('span');
            sentence.className = 'sentence';
            const inputs = {};

            for (const part of field.text.split(/(\{\w+\})/)) {
                const match = part.match(/^\{(\w+)\}$/);

                if (!match) {
                    sentence.append(part);
                    continue;
                }

                const key = match[1];
                const input = document.createElement('input');
                const [min, max] = field.inputs[key];

                input.type = 'number';
                input.step = '1';
                input.min = String(min);
                if (max !== undefined) input.max = String(max);

                input.value = key === 'value' ? value : value[key];
                input.setAttribute('aria-label', field.key + '.' + key);

                inputs[key] = input;
                sentence.appendChild(input);
            }

            row.appendChild(sentence);

            const help = document.createElement('span');
            help.className = 'help';
            help.tabIndex = 0;
            help.textContent = '?';
            help.dataset.help = field.help;
            row.appendChild(help);

            function updateDisabled() {
                const disabled = checkbox && !checkbox.checked;
                row.classList.toggle('disabled', !!disabled);

                Object.values(inputs).forEach(input => {
                    input.disabled = !!disabled;
                });
            }

            checkbox?.addEventListener('change', updateDisabled);
            updateDisabled();

            root.querySelector('[data-group="' + field.group + '"]').appendChild(row);
            controls.push({ field, checkbox, inputs });
        }

        function buildList(kind) {
            const isUser = kind === 'uploaders';
            const page = root.querySelector('[data-page="' + kind + '"]');
            const form = document.createElement('form');

            form.className = 'add';
            form.innerHTML =
                '<input class="entry" required>' +
                '<select class="list">' +
                    '<option value="white">白名单</option>' +
                    '<option value="black">黑名单</option>' +
                '</select>' +
                (isUser ? '' :
                    '<select class="scope">' +
                        '<option value="title">视频标题</option>' +
                        '<option value="id">UP 主名称</option>' +
                        '<option value="all">全部</option>' +
                    '</select>') +
                '<button type="submit">添加</button>';

            const input = form.querySelector('input');
            input.placeholder = isUser ? 'UID（纯数字）' : '关键词正则';

            const table = document.createElement('table');
            table.innerHTML =
                '<thead><tr><th>' + (isUser ? 'UP 主名称' : '正则') +
                '</th><th>' + (isUser ? 'UID' : '范围') +
                '</th><th>操作</th></tr></thead><tbody></tbody>';

            const empty = document.createElement('div');
            empty.className = 'empty';
            empty.textContent = '暂无记录';

            page.append(form, table, empty);

            function render() {
                sortRules(draft[kind], isUser ? 'name' : 'pattern');

                const body = table.tBodies[0];
                body.replaceChildren();
                empty.hidden = draft[kind].length !== 0;

                for (const item of draft[kind]) {
                    const row = body.insertRow();
                    row.className = item.list;
                    row.setAttribute('aria-label', item.list === 'white' ? '白名单' : '黑名单');

                    const first = row.insertCell();
                    const second = row.insertCell();

                    if (isUser) {
                        const link = document.createElement('a');
                        link.href = 'https://space.bilibili.com/' + item.uid;
                        link.target = '_blank';
                        link.rel = 'noopener noreferrer';
                        link.textContent = item.name || nameStatus.get(item.uid) || '名称待补全';

                        first.appendChild(link);
                        second.textContent = item.uid;
                    } else {
                        first.textContent = item.pattern;
                        second.textContent = SCOPE_LABELS[item.scope];
                    }

                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 'delete';
                    button.textContent = '删除';

                    button.addEventListener('click', () => {
                        draft[kind].splice(draft[kind].indexOf(item), 1);
                        render();
                    });

                    row.insertCell().appendChild(button);
                }
            }

            form.addEventListener('submit', async event => {
                event.preventDefault();
                if (adding) return;

                const text = input.value.trim();
                const list = form.querySelector('.list').value;

                message.textContent = '';

                if (isUser) {
                    if (!/^[1-9]\d*$/.test(text)) {
                        message.textContent = '请输入有效的纯数字 UID。';
                        return;
                    }

                    const existing = draft.uploaders.find(item => item.uid === text);
                    let name = existing?.name || '';

                    if (!name) {
                        adding = true;
                        saveButton.disabled = form.querySelector('button').disabled = true;

                        try {
                            name = await getUploaderName(text);
                        } catch (error) {
                            message.textContent = '名称查询失败，仍可保存 UID，之后打开此页时补全。';
                        } finally {
                            adding = false;
                            saveButton.disabled = form.querySelector('button').disabled = false;
                        }
                    }

                    if (!host.isConnected) return;

                    if (existing) Object.assign(existing, { list, name });
                    else draft.uploaders.push({ uid: text, name, list });
                } else {
                    try {
                        parseRegex(text);
                    } catch (error) {
                        message.textContent = error.message;
                        return;
                    }

                    const scope = form.querySelector('.scope').value;

                    if (draft.keywords.some(item =>
                        item.pattern === text &&
                        item.list === list &&
                        item.scope === scope
                    )) {
                        message.textContent = '该规则已存在。';
                        return;
                    }

                    draft.keywords.push({ pattern: text, list, scope });
                }

                input.value = '';
                render();
                input.focus();
            });

            render();
            return render;
        }

        const renderUsers = buildList('uploaders');
        buildList('keywords');

        function fillMissingNames() {
            for (const item of draft.uploaders) {
                if (item.name || nameStatus.has(item.uid)) continue;

                nameStatus.set(item.uid, '查询中…');

                getUploaderName(item.uid).then(name => {
                    item.name = name;

                    const saved = loadConfig();
                    const entry = saved.uploaders.find(value => value.uid === item.uid);

                    if (entry) {
                        entry.name = name;
                        sortRules(saved.uploaders, 'name');
                        GM_setValue(CONFIG_KEY, saved);

                        const live = config.uploaders.find(value => value.uid === item.uid);
                        if (live) live.name = name;
                    }
                }).catch(() => {
                    nameStatus.set(item.uid, '查询失败');
                }).finally(() => {
                    if (host.isConnected) renderUsers();
                });
            }

            renderUsers();
        }

        root.querySelectorAll('[data-tab]').forEach(button => {
            button.addEventListener('click', () => {
                root.querySelectorAll('[data-tab]').forEach(item => {
                    item.classList.toggle('active', item === button);
                });

                root.querySelectorAll('[data-page]').forEach(page => {
                    page.hidden = page.dataset.page !== button.dataset.tab;
                });

                message.textContent = '';

                if (button.dataset.tab === 'uploaders') fillMissingNames();
            });
        });

        const disposeHelp = installHelp(root);

        function close() {
            disposeHelp();
            host.remove();
            settingsHost = null;
            document.removeEventListener('keydown', onKeyDown, true);
        }

        function onKeyDown(event) {
            if (event.key !== 'Escape') return;

            event.preventDefault();
            event.stopPropagation();
            close();
        }

        root.querySelector('.close').addEventListener('click', close);
        root.querySelector('#cancel').addEventListener('click', close);

        root.querySelector('.overlay').addEventListener('click', event => {
            if (event.target.classList.contains('overlay')) close();
        });

        root.querySelector('#reset').addEventListener('click', () => {
            if (!confirm(
                '确定要将所有选项恢复为默认值吗？\n' +
                'UP 主和关键词名单不会受影响。'
            )) return;

            const saved = loadConfig();
            const reset = structuredClone(DEFAULTS);

            reset.uploaders = saved.uploaders;
            reset.keywords = saved.keywords;

            GM_setValue(CONFIG_KEY, reset);
            location.reload();
        });

        saveButton.addEventListener('click', () => {
            for (const { field, checkbox, inputs } of controls) {
                if (checkbox) {
                    if (typeof draft[field.key] === 'boolean')
                        draft[field.key] = checkbox.checked;
                    else
                        draft[field.key].enabled = checkbox.checked;

                    if (!checkbox.checked) continue;
                }

                for (const [key, input] of Object.entries(inputs)) {
                    if (!Number.isSafeInteger(input.valueAsNumber) || !input.checkValidity()) {
                        root.querySelector(
                            '[data-tab="' +
                            (field.group === 'advanced' ? 'advanced' : 'rules') +
                            '"]'
                        ).click();

                        message.textContent = '请输入范围内的整数。';
                        input.focus();
                        return;
                    }

                    if (key === 'value') draft[field.key] = input.valueAsNumber;
                    else draft[field.key][key] = input.valueAsNumber;
                }
            }

            sortRules(draft.uploaders, 'name');
            sortRules(draft.keywords, 'pattern');

            GM_setValue(CONFIG_KEY, draft);
            location.reload();
        });

        document.addEventListener('keydown', onKeyDown, true);
        document.body.appendChild(host);
        root.querySelector('input').focus();
    }

    // 即时气泡，定位在问号上方或下方，避开鼠标。
    function installHelp(root) {
        const bubble = root.querySelector('#help-bubble');
        let anchor = null;

        function hide() {
            bubble.hidden = true;
            anchor?.removeAttribute('aria-describedby');
            anchor = null;
        }

        function show(element) {
            hide();
            anchor = element;
            bubble.textContent = element.dataset.help;
            element.setAttribute('aria-describedby', 'help-bubble');

            bubble.hidden = false;
            bubble.style.visibility = 'hidden';

            const rect = element.getBoundingClientRect();
            const { width, height } = bubble.getBoundingClientRect();
            const center = rect.left + rect.width / 2;

            const left = Math.max(
                16,
                Math.min(center - width / 2, window.innerWidth - width - 16)
            );

            const above = rect.top >= height + 36;

            bubble.dataset.side = above ? 'above' : 'below';
            bubble.style.left = left + 'px';
            bubble.style.top =
                (above ? rect.top - height - 20 : rect.bottom + 20) + 'px';

            bubble.style.setProperty(
                '--arrow-left',
                Math.max(16, Math.min(center - left, width - 16)) + 'px'
            );

            bubble.style.visibility = 'visible';
        }

        root.querySelectorAll('.help').forEach(element => {
            element.setAttribute('aria-label', '说明');
            element.addEventListener('pointerenter', () => show(element));
            element.addEventListener('pointerleave', hide);
            element.addEventListener('focus', () => show(element));
            element.addEventListener('blur', hide);
        });

        root.addEventListener('scroll', hide, true);
        root.querySelector('nav').addEventListener('click', hide);
        window.addEventListener('resize', hide);

        return () => {
            hide();
            window.removeEventListener('resize', hide);
        };
    }

    function request(path, query = '', priority = PRIORITY.NORMAL) {
        return new Promise((resolve, reject) => {
            queue.push({
                path,
                query,
                priority,
                sequence: queueSequence++,
                resolve,
                reject
            });

            // 优先级数值越小越优先；同优先级保持 FIFO。
            queue.sort((a, b) =>
                a.priority - b.priority ||
                a.sequence - b.sequence
            );

            pump();
        });
    }

    function pump() {
        while (active < config.concurrency && queue.length) {
            const job = queue.shift();
            active++;

            send(job.path, job.query)
                .then(job.resolve, job.reject)
                .finally(() => {
                    active--;
                    pump();
                });
        }
    }

    function promotePriority(priority) {
        return priority === PRIORITY.LOW
            ? PRIORITY.NORMAL
            : PRIORITY.HIGH;
    }

    function send(path, query) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: API + path + (query ? '?' + query : ''),
                anonymous: false,
                timeout: 15000,

                onload(response) {
                    let data;

                    try {
                        data = JSON.parse(response.responseText);
                    } catch (_) {}

                    const risk =
                        [412, 429].includes(response.status) ||
                        [-352, -412, -509].includes(data?.code) ||
                        (!data && /captcha|验证码/i.test(response.responseText));

                    if (risk) {
                        if (config.debug || !riskAlerted) {
                            riskAlerted = true;

                            alert(
                                `B站接口触发风控或限流。\n` +
                                `失败请求不重试，其余队列继续执行。\n` +
                                `接口：${path}\n` +
                                `HTTP：${response.status}\n` +
                                `错误：${data?.code ?? '非JSON响应'} ${data?.message ?? ''}`
                            );
                        }

                        reject(new Error('风控或限流'));
                    } else if (response.status !== 200 || !data) {
                        reject(new Error(`接口响应异常：HTTP ${response.status}`));
                    } else {
                        resolve(data);
                    }
                },

                onerror: () => reject(new Error('网络请求失败')),
                ontimeout: () => reject(new Error('网络请求超时')),
                onabort: () => reject(new Error('网络请求已中止'))
            });
        });
    }

    function checkResponse(response) {
        if (response.code !== 0)
            throw new Error(`${response.code}：${response.message}`);

        return response.data;
    }

    function md5(text) {
        const bytes = new TextEncoder().encode(text);
        const words = new Int32Array((((bytes.length + 8) >>> 6) + 1) * 16);

        bytes.forEach((value, i) => {
            words[i >>> 2] |= value << ((i % 4) * 8);
        });

        words[bytes.length >>> 2] |= 0x80 << ((bytes.length % 4) * 8);
        words[words.length - 2] = bytes.length * 8;

        const shifts = [
            7, 12, 17, 22,
            5, 9, 14, 20,
            4, 11, 16, 23,
            6, 10, 15, 21
        ];

        const hash = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476];

        for (let offset = 0; offset < words.length; offset += 16) {
            let [a, b, c, d] = hash;

            for (let i = 0; i < 64; i++) {
                let f, g;

                if (i < 16) {
                    f = (b & c) | (~b & d);
                    g = i;
                } else if (i < 32) {
                    f = (d & b) | (~d & c);
                    g = (5 * i + 1) % 16;
                } else if (i < 48) {
                    f = b ^ c ^ d;
                    g = (3 * i + 5) % 16;
                } else {
                    f = c ^ (b | ~d);
                    g = (7 * i) % 16;
                }

                const value = (
                    a + f + words[offset + g] +
                    (Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0)
                ) | 0;

                const shift = shifts[(i >>> 4) * 4 + i % 4];
                const next = (b + ((value << shift) | (value >>> (32 - shift)))) | 0;

                [a, b, c, d] = [d, next, b, c];
            }

            [a, b, c, d].forEach((value, i) => {
                hash[i] = (hash[i] + value) | 0;
            });
        }

        return hash.map(value =>
            [0, 8, 16, 24].map(shift =>
                ((value >>> shift) & 255).toString(16).padStart(2, '0')
            ).join('')
        ).join('');
    }

    async function getSigningKey() {
        const response = await request('/x/web-interface/nav', '', PRIORITY.HIGH);
        const images = response.data?.wbi_img;

        if (!images?.img_url || !images?.sub_url)
            throw new Error('未取得WBI签名密钥');

        const stem = value => new URL(value).pathname.split('/').pop().split('.')[0];
        const raw = stem(images.img_url) + stem(images.sub_url);

        const order = [
            46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
            27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
            37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
            22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
        ];

        const key = order.map(i => raw[i] || '').join('').slice(0, 32);

        if (key.length !== 32) throw new Error('WBI密钥格式异常');
        return key;
    }

    function sign(params, key) {
        const values = { ...params, wts: Math.floor(Date.now() / 1000) };

        const query = Object.keys(values).sort().map(name =>
            encodeURIComponent(name) + '=' +
            encodeURIComponent(String(values[name]).replace(/[!'()*]/g, ''))
        ).join('&');

        return query + '&w_rid=' + md5(query + key);
    }

    function memo(cache, key, create) {
        if (!cache.has(key)) cache.set(key, Promise.resolve().then(create));
        return cache.get(key);
    }

    function getUploads(mid, priority = PRIORITY.NORMAL) {
        return memo(uploads, mid, async () => {
            const key = await prepareKey();
            if (!key) throw new Error('WBI 密钥不可用');

            const data = checkResponse(await request(
                '/x/space/wbi/arc/search',
                sign({
                    mid,
                    pn: 1,
                    ps: 10,
                    order: 'pubdate',
                    tid: 0,
                    keyword: ''
                }, key),
                priority
            ));

            const videos = data?.list?.vlist;
            const count = data?.page?.count;

            if (!Array.isArray(videos) ||
                !Number.isSafeInteger(count) ||
                count < videos.length) {
                throw new Error('投稿列表或投稿总数无效');
            }

            const ids = videos.map(item => item.bvid || item.aid);

            if (ids.some(id => !id) || new Set(ids).size !== ids.length)
                throw new Error('投稿视频 ID 无效或重复');

            return { videos, count };
        });
    }

    function getUploaderInfo(mid, priority = PRIORITY.NORMAL) {
        return memo(uploaderInfos, mid, async () => {
            const key = await prepareKey();
            if (!key) throw new Error('WBI 密钥不可用');

            const data = checkResponse(await request(
                '/x/space/wbi/acc/info',
                sign({ mid }, key),
                priority
            ));

            if (!data || String(data.mid ?? '') !== String(mid))
                throw new Error('UP 主资料无效');

            return data;
        });
    }

    function getUploaderCard(mid, priority = PRIORITY.NORMAL) {
        return memo(uploaderCards, mid, async () =>
            checkResponse(await request(
                '/x/web-interface/card',
                new URLSearchParams({ mid }).toString(),
                priority
            ))
        );
    }

    async function getFollowers(mid, priority = PRIORITY.NORMAL) {
        const data = await getUploaderCard(mid, priority);
        const count = data?.follower ?? data?.card?.fans;

        if (!Number.isSafeInteger(count) || count < 0)
            throw new Error('粉丝数无效');

        return count;
    }

    async function getUploaderName(mid, priority = PRIORITY.NORMAL) {
        // 若之前已经查询过 acc/info，直接复用其中的名称，避免额外 card 请求。
        const infoPromise = uploaderInfos.get(mid);

        if (infoPromise) {
            try {
                const info = await infoPromise;

                if (typeof info?.name === 'string' && info.name.trim())
                    return info.name.trim();
            } catch (_) {}
        }

        const data = await getUploaderCard(mid, priority);

        if (typeof data?.card?.name !== 'string' || !data.card.name.trim())
            throw new Error('未返回 UP 主名称');

        return data.card.name.trim();
    }

    function getVideo(video, priority = PRIORITY.NORMAL) {
        return memo(details, video, async () => {
            const params = video.startsWith('BV')
                ? { bvid: video }
                : { aid: video.slice(2) };

            const data = checkResponse(await request(
                '/x/web-interface/view',
                new URLSearchParams(params).toString(),
                priority
            ));

            if (!sameVideo(data, video))
                throw new Error('视频详情与请求不一致');

            return data;
        });
    }

    function sameVideo(item, video) {
        return !!item && (item.bvid === video || 'av' + item.aid === video);
    }

    function userRule(mid) {
        return config.uploaders.find(item => item.uid === mid);
    }

    function hasOfficial(info) {
        return Number.isInteger(info?.official?.type) &&
            info.official.type >= 0;
    }

    function hasAttestation(info) {
        return Number(info?.attestation?.type) > 0 ||
            !!info?.attestation?.common_info?.prefix?.trim();
    }

    function hasAnnualVip(info) {
        return Number(info?.vip?.type) === 2 &&
            Number(info?.vip?.status) === 1;
    }

    function isInViewport(element) {
        if (!element?.isConnected) return false;

        const rect = element.getBoundingClientRect();

        return rect.bottom > 0 &&
            rect.right > 0 &&
            rect.top < window.innerHeight &&
            rect.left < window.innerWidth;
    }

    function findKeyword(list, name, title) {
        for (const rule of keywords) {
            if (rule.list !== list) continue;

            if (rule.scope !== 'id' && title != null && rule.regex.test(title))
                return '关键词黑名单（标题）：' + rule.pattern;

            if (rule.scope !== 'title' && name != null && rule.regex.test(name))
                return '关键词黑名单（UP 主名称）：' + rule.pattern;
        }

        return '';
    }

    function parseViews(value) {
        const match = String(value ?? '')
            .trim()
            .replace(/,/g, '')
            .match(/^(\d+(?:\.\d+)?)(万|亿)?$/);

        if (!match) return null;

        const scale = { 万: 10000, 亿: 100000000 }[match[2]] || 1;
        const count = Math.round(Number(match[1]) * scale);

        return Number.isSafeInteger(count) && count >= 0 ? count : null;
    }

    function cardViews(card, layout) {
        const node = card.querySelector(layout.play);
        if (!node) return null;

        // 右侧推荐的播放量是 svg.play 后面的文本节点，不能混入弹幕数。
        if (layout === RELATED) {
            let text = '';

            for (
                let sibling = node.nextSibling;
                sibling && sibling.nodeType === Node.TEXT_NODE;
                sibling = sibling.nextSibling
            ) {
                text += sibling.textContent;
            }

            return parseViews(text);
        }

        return parseViews(node.textContent);
    }

    function automaticReason({ videos, count }, video) {
        const limit = config.frequency.count;

        if (config.frequency.enabled && videos.length >= limit) {
            const times = videos.slice(0, limit).map(item => item.created);

            if (times.some(time => !Number.isFinite(time) || time <= 0) ||
                times.some((time, index) => index && time > times[index - 1])) {
                throw new Error('投稿时间或排序异常');
            }

            const hours = (times[0] - times[limit - 1]) / 3600;

            if (hours < config.frequency.hours)
                return limit + ' 条投稿跨度 ' + hours.toFixed(2) + ' 小时';
        }

        if (config.hidden.enabled &&
            video &&
            count < limit &&
            count < config.hidden.count &&
            videos.length === count &&
            !videos.some(item => sameVideo(item, video))) {
            return '当前视频未在主页显示，可见投稿 ' + count + ' 条';
        }

        return '';
    }

    // 首页、相关视频、当前 UP 主共用。
    // 放行返回空字符串；请求失败抛出异常。
    async function getClickbaitReason(mid, context = {}) {
        const explicit = userRule(mid);

        if (explicit)
            return explicit.list === 'white' ? '' : 'UP 主黑名单';

        let {
            name = null,
            title = null,
            video = null,
            views = null,
            following = null,
            priority = PRIORITY.NORMAL
        } = context;

        if (findKeyword('white', name, title)) return '';

        if (!name && keywords.some(rule => rule.scope !== 'title')) {
            name = await getUploaderName(mid, priority);
            if (findKeyword('white', name, title)) return '';
        }

        const black = findKeyword('black', name, title);
        if (black) return black;

        if (config.allowFollowing && following === true)
            return '';

        if (config.views.enabled && video) {
            if (views === null) {
                if (config.debug)
                    alert('当前视频播放量缺失，本次不应用播放量豁免。\n视频：' + video);
            } else if (views >= config.views.count) {
                return '';
            }
        }

        if (!config.frequency.enabled && (!config.hidden.enabled || !video))
            return '';

        const listing = await getUploads(mid, priority);

        if (config.allowRepost &&
            listing.videos.some(item => Number(item.copyright) === 2)) {
            return '';
        }

        const reason = automaticReason(listing, video);
        if (!reason) return '';

        // 已经进入最终放行判断：对 acc/info / card 适当提权，
        // 让当前可见卡片和即将得出结论的任务更快完成。
        const finalPriority = promotePriority(priority);

        if (config.allowFollowing ||
            config.allowOfficial ||
            config.allowAttestation ||
            config.allowAnnualVip) {
            const info = await getUploaderInfo(mid, finalPriority);

            if (config.allowFollowing && info.is_followed === true)
                return '';

            if (config.allowOfficial && hasOfficial(info))
                return '';

            if (config.allowAttestation && hasAttestation(info))
                return '';

            if (config.allowAnnualVip && hasAnnualVip(info))
                return '';
        }

        // 粉丝数是最后一道检查，尽量减少 card 调用次数。
        if (config.followers.enabled &&
            await getFollowers(mid, finalPriority) > config.followers.count) {
            return '';
        }

        return userRule(mid)?.list === 'white' ? '' : reason;
    }

    async function inspectUploader(video, mid, version) {
        const route = location.hostname + location.pathname;

        try {
            let name = '';
            let title = null;
            let views = null;

            if (video) {
                const data = await getVideo(video, PRIORITY.HIGH);

                mid = String(data.owner?.mid ?? '');
                name = data.owner?.name || '';
                title = data.title || null;
                views = parseViews(data.stat?.view);
            }

            if (!/^[1-9]\d*$/.test(mid) ||
                promptedUploaders.has(mid) ||
                userRule(mid)?.list === 'white') return;

            const reason = await getClickbaitReason(mid, {
                name,
                title,
                video,
                views,
                priority: PRIORITY.HIGH
            });

            if (!reason ||
                version !== routeVersion ||
                route !== location.hostname + location.pathname ||
                promptedUploaders.has(mid) ||
                userRule(mid)?.list === 'white') return;

            promptedUploaders.add(mid);

            if (!confirm(
                '你正在观看的 UP 主因“' + reason +
                '”会被屏蔽，是否加入白名单？\nUID：' + mid
            )) return;

            if (!name) {
                try {
                    name = await getUploaderName(mid);
                } catch (error) {
                    console.warn('[MnFeN]', mid, error.message);
                }
            }

            const saved = loadConfig();

            saved.uploaders = saved.uploaders.filter(item => item.uid !== mid);
            saved.uploaders.push({ uid: mid, name, list: 'white' });

            sortRules(saved.uploaders, 'name');
            GM_setValue(CONFIG_KEY, saved);

            config.uploaders = saved.uploaders;
            decisions.clear();
            scheduleUpdate();
        } catch (error) {
            console.warn('[MnFeN]', mid || video, error.message);
        }
    }

    function readCard(card, layout) {
        const title = card.querySelector(layout.title);
        const link = card.querySelector(layout.link);
        const owner = card.querySelector(layout.owner);
        const author = card.querySelector(layout.name);

        if (!title || !link || !owner || !author) return null;

        const ownerURL = new URL(owner.href);
        const videoURL = new URL(link.href);

        if (ownerURL.hostname !== 'space.bilibili.com' ||
            videoURL.hostname !== 'www.bilibili.com') return null;

        const midMatch = ownerURL.pathname.match(/^\/([1-9]\d*)(?:\/|$)/);
        const videoMatch = videoURL.pathname.match(/^\/video\/(BV\w+|av\d+)(?:\/|$)/);

        if (!midMatch || !videoMatch) return null;

        const clone = title.cloneNode(true);
        clone.querySelectorAll('.MnFeN-filter-reason').forEach(node => node.remove());

        const caption = clone.textContent.trim();
        const name = author.textContent.trim();

        if (!caption || !name) return null;

        const views = cardViews(card, layout);
        const following = layout === HOME &&
            card.querySelector(
                '.bili-video-card__info--bottom > .bili-video-card__info--icon-text'
            )?.textContent.trim() === '已关注'
                ? true
                : null;

        const mid = midMatch[1];
        const video = videoMatch[1];
        let target = card;

        // 首页连续的卡片包装层一起隐藏；右侧列表直接隐藏卡片本身。
        if (layout === HOME) {
            while (target.parentElement?.matches('.bili-feed-card, .feed-card')) {
                target = target.parentElement;
            }
        }

        return {
            mid,
            video,
            title,
            target,
            name,
            caption,
            views,
            following,
            identity: JSON.stringify([
                mid,
                video,
                name,
                caption,
                views,
                following
            ])
        };
    }

    function clearMark(title) {
        const previous = marked.get(title);

        previous?.label?.remove();
        previous?.target.classList.remove('MnFeN-clickbait-hidden');
        title.classList.remove('MnFeN-frequency-title');

        marked.delete(title);
    }

    function markCard(info, reason) {
        const { title, target, identity } = info;
        const previous = marked.get(title);

        if (previous?.identity === identity &&
            previous.reason === reason &&
            previous.target === target) {
            if (!config.debug) {
                target.classList.add('MnFeN-clickbait-hidden');
                return;
            }

            if (previous.label?.parentNode === title) {
                if (title.firstChild !== previous.label)
                    title.prepend(previous.label);

                title.classList.add('MnFeN-frequency-title');
                return;
            }
        }

        clearMark(title);

        let label = null;

        if (config.debug) {
            label = document.createElement('span');
            label.className = 'MnFeN-filter-reason';
            label.textContent = `（${reason}）`;

            title.prepend(label);
            title.classList.add('MnFeN-frequency-title');
        } else {
            target.classList.add('MnFeN-clickbait-hidden');
        }

        marked.set(title, { identity, reason, target, label });
    }

    function scan(layout) {
        const cards = new Map();

        if (layout) {
            for (const card of document.querySelectorAll(layout.cards)) {
                const info = readCard(card, layout);
                if (info) cards.set(info.title, info);
            }
        }

        for (const [title, previous] of marked) {
            const info = cards.get(title);

            if (!info ||
                info.identity !== previous.identity ||
                info.target !== previous.target) {
                clearMark(title);
            }
        }

        // 可见卡片先进入判断流程；屏幕外卡片排到后面。
        const orderedCards = [...cards.values()]
            .sort((a, b) =>
                Number(!isInViewport(a.target)) -
                Number(!isInViewport(b.target))
            );

        for (const info of orderedCards) {
            if (userRule(info.mid)?.list === 'white') {
                if (marked.has(info.title)) clearMark(info.title);
                continue;
            }

            const key = info.identity;

            if (decisions.has(key)) {
                const reason = decisions.get(key);

                if (reason)
                    markCard(info, reason);
                else if (marked.has(info.title))
                    clearMark(info.title);

                continue;
            }

            decisions.set(key, null);

            const priority = isInViewport(info.target)
                ? PRIORITY.HIGH
                : PRIORITY.LOW;

            getClickbaitReason(info.mid, {
                name: info.name,
                title: info.caption,
                video: info.video,
                views: info.views,
                following: info.following,
                priority
            }).then(reason => {
                decisions.set(key, reason);
                scheduleUpdate();
            }).catch(error => {
                console.warn('[MnFeN]', info.mid, error.message);
            });
        }
    }

    function getPage() {
        if (location.hostname === 'space.bilibili.com') {
            const match = location.pathname.match(/^\/([1-9]\d*)(?:\/|$)/);
            if (match) return { type: 'space', mid: match[1] };
        }

        if (location.hostname === 'www.bilibili.com') {
            if (location.pathname === '/') return { type: 'home' };

            const match = location.pathname.match(/^\/video\/(BV\w+|av\d+)(?:\/|$)/);
            if (match) return { type: 'video', video: match[1] };
        }

        return { type: null };
    }

    function updatePage() {
        const page = getPage();
        const route = location.hostname + location.pathname;

        if (route !== lastRoute) {
            lastRoute = route;
            routeVersion++;

            if (page.type) prepareKey();

            if (config.promptWhitelist && page.type === 'space')
                inspectUploader(null, page.mid, routeVersion);
            else if (config.promptWhitelist && page.type === 'video')
                inspectUploader(page.video, null, routeVersion);
        }

        let layout = null;

        if (page.type === 'home' && config.filterHome)
            layout = HOME;

        if (page.type === 'video' && config.filterRelated)
            layout = RELATED;

        scan(layout);
    }

    function scheduleUpdate() {
        if (!started || updateTimer) return;

        updateTimer = setTimeout(() => {
            updateTimer = null;
            updatePage();
        }, 250);
    }

    function start() {
        started = true;

        const style = document.createElement('style');

        style.textContent = `
            .MnFeN-frequency-title,
            .MnFeN-frequency-title * {
                color: #e53935 !important;
            }
            .MnFeN-clickbait-hidden {
                display: none !important;
            }
        `;

        document.head.appendChild(style);

        new MutationObserver(scheduleUpdate).observe(document.body, {
            childList: true,
            subtree: true,
            characterData: true,
            attributes: true,
            attributeFilter: ['href', 'title']
        });

        window.addEventListener('popstate', scheduleUpdate);
        updatePage();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
        start();
    }
})();
