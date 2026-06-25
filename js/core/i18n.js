(function() {
'use strict';

var _locale = null;
var _lang = 'zh-TW';
var _fallback = {};
var _listeners = [];
var _LOADED = {};

function _t(key) {
    var fallback = key.split('.').reduce(function(o, k) { return o && o[k] !== undefined ? o[k] : null; }, _fallback);
    var val = key.split('.').reduce(function(o, k) { return o && o[k] !== undefined ? o[k] : null; }, _locale);
    var str = val !== null ? val : (fallback !== null ? fallback : key);
    if (typeof str === 'string') {
        var args = Array.prototype.slice.call(arguments, 1);
        str = str.replace(/\{(\d+)\}/g, function(m, i) { return args[i] !== undefined ? args[i] : m; });
    }
    return str;
}

function _langGet() { return _lang; }

function _langSet(lang) {
    if (lang === _lang && _locale) return;
    var prev = _lang;
    _lang = lang;
    localStorage.setItem('clipper_lang', lang);
    var locale = _LOADED[lang];
    if (locale) {
        _locale = locale;
        _notify(prev, lang);
    } else {
        _loadLocale(lang);
    }
}

function _loadLocale(lang) {
    var url = 'js/i18n/' + lang + '.js';
    var script = document.createElement('script');
    script.src = url;
    script.onload = function() {
        if (_LOADED[lang]) {
            _locale = _LOADED[lang];
            _notify(_lang, lang);
        }
    };
    script.onerror = function() {
        if (lang !== 'zh-TW') _langSet('zh-TW');
    };
    document.head.appendChild(script);
}

function _registerLocale(lang, dict) {
    _LOADED[lang] = dict;
    if (lang === 'zh-TW') _fallback = dict;
    if (lang === _lang && !_locale) {
        _locale = dict;
        _notify(null, lang);
    }
}

function _onChange(fn) { _listeners.push(fn); return function() { _listeners = _listeners.filter(function(f) { return f !== fn; }); }; }

function _notify(prev, curr) {
    _listeners.forEach(function(fn) { try { fn(prev, curr); } catch(e) {} });
    document.querySelectorAll('[data-i18n]').forEach(function(el) {
        var key = el.dataset.i18n;
        var val = _t(key);
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            el.placeholder = val;
        } else {
            el.textContent = val;
        }
    });
}

// Auto-load saved language
var saved = localStorage.getItem('clipper_lang');
if (saved && saved !== 'zh-TW') {
    _lang = saved;
    _loadLocale(saved);
}

// Export globals
window._t = _t;
window._langGet = _langGet;
window._langSet = _langSet;
window._registerLocale = _registerLocale;
window._i18nOnChange = _onChange;

})();
