class PluginLoader {
    constructor(registry) {
        this._registry = registry;
        this._loading = new Set();
    }

    loadFromUrl(url) {
        if (this._loading.has(url)) return Promise.resolve();
        this._loading.add(url);
        return new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = url;
            script.onload = () => { this._loading.delete(url); resolve(); };
            script.onerror = (err) => { this._loading.delete(url); reject(err); };
            document.body.appendChild(script);
        });
    }

    loadFromDirectory(baseUrl) {
        const manifestUrl = baseUrl + '/manifest.json';
        return fetch(manifestUrl)
            .then(r => r.json())
            .then(manifest => {
                if (!manifest.plugins) return;
                const promises = manifest.plugins.map(p => {
                    if (p.script) return this.loadFromUrl(baseUrl + '/' + p.script);
                }).filter(Boolean);
                return Promise.all(promises);
            })
            .catch(() => {
                // No manifest — scan individual plugin files
            });
    }

    loadFromManifest(json) {
        if (!json.plugins) return;
        for (const p of json.plugins) {
            if (p.script) {
                this.loadFromUrl(p.script);
            }
        }
    }
}
