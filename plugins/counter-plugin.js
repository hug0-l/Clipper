(function() {
    var _val = 0;
    var _container = null;

    ClipperPlugins.register({
        name: 'counter',
        version: '1.0.0',
        displayName: '計數器',
        description: '協作計數器 — 同房所有用戶同步',
        icon: '🔢',
        tab: { position: 'dropdown', title: '🔢 計數器', afterTarget: 'about' },
        css: '.plugin-counter-val{font-size:48px;font-weight:700;color:#38bdf8;text-align:center;padding:20px;}' +
              '.plugin-counter-btn{font-size:24px;padding:10px 20px;margin:0 8px;}' +
              '.plugin-counter-wrap{max-width:400px;margin:40px auto;text-align:center;}',

        wsHandlers: {
            'relay-data': function(data) {
                if (data.data && data.data.type === 'plugin-counter-update') {
                    _val = data.data.value;
                    var el = document.getElementById('pluginCounterVal');
                    if (el) el.textContent = _val;
                }
            }
        },

        mount: function(container) {
            _container = container;
            _val = 0;
            container.innerHTML = '<div class="plugin-counter-wrap">' +
                '<h2 style="font-size:22px;margin-bottom:8px;">🔢 協作計數器</h2>' +
                '<p style="color:#94a3b8;font-size:14px;margin-bottom:20px;">所有同房用戶同步</p>' +
                '<div class="plugin-counter-val" id="pluginCounterVal">0</div>' +
                '<div><button class="btn btn-primary plugin-counter-btn" id="pluginCounterDec">−</button>' +
                '<button class="btn btn-primary plugin-counter-btn" id="pluginCounterInc">+</button></div>' +
                '<div style="margin-top:20px;"><button class="btn btn-secondary" id="pluginCounterReset">重設</button></div>' +
                '</div>';

            document.getElementById('pluginCounterInc').addEventListener('click', function() {
                _val++;
                broadcastCounter();
            });
            document.getElementById('pluginCounterDec').addEventListener('click', function() {
                _val--;
                broadcastCounter();
            });
            document.getElementById('pluginCounterReset').addEventListener('click', function() {
                _val = 0;
                broadcastCounter();
            });
        },

        unmount: function() {
            _container = null;
        }
    });

    function broadcastCounter() {
        var el = document.getElementById('pluginCounterVal');
        if (el) el.textContent = _val;
        if (APP.state.room && APP.state.ws && APP.state.ws.readyState === WebSocket.OPEN) {
            broadcastToPeers(JSON.stringify({
                type: 'plugin-counter-update', value: _val
            }));
        }
    }
})();
