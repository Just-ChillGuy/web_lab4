const App = (() => {
  const API = {
    GEOCODE_SEARCH: 'https://geocoding-api.open-meteo.com/v1/search',
    GEOCODE_REVERSE: 'https://geocoding-api.open-meteo.com/v1/reverse',
    FORECAST: 'https://api.open-meteo.com/v1/forecast'
  };
  const UI_IDS = {
    WEATHER_CONTAINER: 'weatherContainer',
    SUGGESTIONS: 'suggestions',
    CITY_ERROR: 'cityError',
    CITY_INPUT: 'cityInput',
    REFRESH_BTN: 'refreshBtn',
    ADD_BTN: 'addCityBtn',
    GEO_BTN: 'geoBtn',
    CURRENT_LOCATION: 'currentLocation'
  };
  const DEFAULTS = {
    SUGGEST_COUNT: 8,
    GEO_COUNT: 5,
    FORECAST_DAYS: 4,
    AUTOCOMPLETE_DEBOUNCE_MS: 250,
    GEO_TIMEOUT_MS: 10000
  };

  const $ = (id) => document.getElementById(id);

  function safeParseJSONWithFallback(raw, fallback) {
    try {
      if (raw === null || typeof raw === 'undefined') return fallback;
      const parsed = JSON.parse(raw);
      return (parsed === null) ? fallback : parsed;
    } catch (e) {
      return fallback;
    }
  }

  const storage = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return safeParseJSONWithFallback(raw, fallback);
      } catch (e) {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); }
      catch (e) { console.warn('localStorage set failed', e); }
    }
  };

  function uid(len = 7) { return Math.random().toString(36).slice(2, 2 + len); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, (m) => ({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[m])); }
  function formatHumanDate(iso) {
    try {
      const d = new Date(iso);
      if (isNaN(d)) return String(iso);
      const months = ["января","февраля","марта","апреля","мая","июня","июля","августа","сентября","октября","ноября","декабря"];
      return `${d.getDate()} ${months[d.getMonth()]}`;
    } catch (e) { return String(iso); }
  }
  function debounce(fn, ms) { let t = null; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); }; }

  const WEATHER_MAP = {
    0: "Ясно",1: "Частично облачно",2: "Облачно",3: "Пасмурно",45: "Туман",48: "Туман с инеем",
    51: "Мелкий дождь",53: "Умеренный дождь",55: "Сильный дождь",61: "Дождь",63: "Сильный дождь",
    65: "Сильный дождь",71: "Снег",73: "Сильный снег",75: "Очень сильный снег",80: "Ливень",
    81: "Сильный ливень",82: "Очень сильный ливень",95: "Гроза",96: "Гроза с небольшим градом",99: "Гроза с градом"
  };

  async function apiGeocode(q, count = DEFAULTS.SUGGEST_COUNT) {
    const url = `${API.GEOCODE_SEARCH}?name=${encodeURIComponent(q)}&count=${count}&language=ru&format=json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Ошибка подсказки (geocode)');
    return res.json();
  }

  async function apiGeocodeReverse(lat, lon, count = 1) {
    try {
      const url = `${API.GEOCODE_REVERSE}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&count=${count}&language=ru`;
      const res = await fetch(url);
      if (!res.ok) return null;
      return res.json();
    } catch (e) {
      console.warn('apiGeocodeReverse fetch failed (network/CORS):', e);
      return null;
    }
  }

  async function apiForecast(lat, lon, days = DEFAULTS.FORECAST_DAYS) {
    const url = `${API.FORECAST}?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&daily=temperature_2m_max,temperature_2m_min,weathercode&timezone=auto&forecast_days=${days}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error('Ошибка получения прогноза');
    return res.json();
  }

  class WeatherApp {
    constructor() {
      this.dom = {
        panel: $(UI_IDS.WEATHER_CONTAINER),
        suggestions: $(UI_IDS.SUGGESTIONS),
        error: $(UI_IDS.CITY_ERROR),
        input: $(UI_IDS.CITY_INPUT),
        refresh: $(UI_IDS.REFRESH_BTN),
        add: $(UI_IDS.ADD_BTN),
        geo: $(UI_IDS.GEO_BTN),
        headerLocation: $(UI_IDS.CURRENT_LOCATION)
      };

      this.cities = storage.get('cities', []) || [];
      this.currentPick = null;
      this.geocodeCache = new Map();
      this._bindHandlers();
      if (this.dom.suggestions) { this.dom.suggestions.style.display = 'none'; this.dom.suggestions.innerHTML = ''; }
    }

    _bindHandlers() {
      if (this.dom.input) {
        this.dom.input.addEventListener('input', debounce((e) => this._onInput(e), DEFAULTS.AUTOCOMPLETE_DEBOUNCE_MS));
        this.dom.input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') { ev.preventDefault(); this.addCityFromInput(); }
          if (ev.key === 'Escape' && this.dom.suggestions) { this.dom.suggestions.style.display = 'none'; this.dom.suggestions.innerHTML = ''; }
        });
      }
      if (this.dom.suggestions) {
        this.dom.suggestions.addEventListener('click', (e) => {
          const li = e.target.closest('li'); if (!li) return;
          const lat = parseFloat(li.dataset.lat); const lon = parseFloat(li.dataset.lon);
          const display = li.dataset.display || li.textContent.trim();
          this.currentPick = { name: display.split(',')[0].trim(), displayName: display, lat, lon };
          this.dom.input.value = display;
          this.dom.suggestions.style.display = 'none'; this.dom.suggestions.innerHTML = '';
        });
      }
      document.addEventListener('click', (e) => {
        if (!this.dom.input.contains(e.target) && this.dom.suggestions && !this.dom.suggestions.contains(e.target)) {
          this.dom.suggestions.style.display = 'none'; this.dom.suggestions.innerHTML = '';
        }
      });
      if (this.dom.refresh) this.dom.refresh.addEventListener('click', () => this.refreshAllCards());
      if (this.dom.add) this.dom.add.addEventListener('click', () => this.addCityFromInput());
      if (this.dom.geo) this.dom.geo.addEventListener('click', () => this.addOrUpdateGeo(true));
    }

    async _onInput() {
      const q = this.dom.input.value.trim();
      this.currentPick = null;
      if (this.dom.error) this.dom.error.textContent = '';
      if (!q) { if (this.dom.suggestions) { this.dom.suggestions.style.display = 'none'; this.dom.suggestions.innerHTML = ''; } return; }
      if (this.geocodeCache.has(q)) { this._renderSuggestions(this.geocodeCache.get(q)); return; }
      try {
        const data = await apiGeocode(q, DEFAULTS.SUGGEST_COUNT);
        const list = (data && data.results) ? data.results : [];
        this.geocodeCache.set(q, list);
        this._renderSuggestions(list);
      } catch (err) { console.warn('autocomplete error', err); if (this.dom.suggestions) this.dom.suggestions.style.display = 'none'; }
    }

    _renderSuggestions(results) {
      if (!this.dom.suggestions) return;
      if (!results || results.length === 0) { this.dom.suggestions.style.display = 'none'; this.dom.suggestions.innerHTML = ''; return; }
      this.dom.suggestions.innerHTML = results.map(r => {
        const disp = `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}${r.country ? ', ' + r.country : ''}`;
        return `<li data-lat="${r.latitude}" data-lon="${r.longitude}" data-display="${escapeHtml(disp)}">${escapeHtml(disp)}</li>`;
      }).join('');
      this.dom.suggestions.style.display = 'block';
    }

    async addCityFromInput() {
      const raw = (this.dom.input && this.dom.input.value) ? this.dom.input.value.trim() : '';
      if (this.dom.error) this.dom.error.textContent = '';
      if (!raw) { if (this.dom.error) this.dom.error.textContent = 'Введите название города'; return; }
      try {
        if (this.currentPick && this.currentPick.displayName === raw) {
          const best = this.currentPick;
          if (this._isDuplicateCoords(best.lat, best.lon)) { if (this.dom.error) this.dom.error.textContent = 'Этот город уже добавлен.'; return; }
          this.cities.push({ id: uid(), name: best.name, displayName: best.displayName, lat: best.lat, lon: best.lon, isGeo: false });
          storage.set('cities', this.cities); this.dom.input.value = ''; this.currentPick = null; this.renderAll(); return;
        }
        if (this.dom.error) this.dom.error.textContent = 'Проверка...';
        const geoResp = await apiGeocode(raw, DEFAULTS.GEO_COUNT);
        if (!geoResp.results || geoResp.results.length === 0) { if (this.dom.error) this.dom.error.textContent = 'Город не найден.'; return; }
        const best = geoResp.results[0];
        if (this._isDuplicateCoords(best.latitude, best.longitude)) { if (this.dom.error) this.dom.error.textContent = 'Этот город уже добавлен.'; return; }
        const displayName = `${best.name}${best.admin1 ? ', ' + best.admin1 : ''}${best.country ? ', ' + best.country : ''}`;
        this.cities.push({ id: uid(), name: best.name, displayName, lat: best.latitude, lon: best.longitude, isGeo: false });
        storage.set('cities', this.cities); this.dom.input.value = ''; if (this.dom.error) this.dom.error.textContent = ''; this.renderAll();
      } catch (err) { console.error('handleAddCity error', err); if (this.dom.error) this.dom.error.textContent = 'Ошибка сети'; }
    }

    _isDuplicateCoords(lat, lon) {
      return Array.isArray(this.cities) && this.cities.some(c => Math.abs((c.lat || 0) - (lat || 0)) < 1e-6 && Math.abs((c.lon || 0) - (lon || 0)) < 1e-6);
    }

    renderAll() {
      if (!this.dom.panel) return;
      this.dom.panel.innerHTML = '';
      if (!Array.isArray(this.cities) || this.cities.length === 0) {
        this.dom.panel.innerHTML = `<p class="loading">Нет сохранённых городов. Разрешите геолокацию или добавьте город вручную.</p>`;
        this._refreshHeader();
        return;
      }
      for (const city of this.cities) {
        const card = this._createCardElement(city);
        this.dom.panel.appendChild(card);
        this._fillCardForecast(city, card);
      }
      this._refreshHeader();
    }

    _createCardElement(city) {
      const wrapper = document.createElement('div');
      wrapper.className = 'weather-card'; wrapper.dataset.id = city.id;
      wrapper.innerHTML = `
        <div class="card-top">
          <div>
            <div class="card-title">${escapeHtml(city.displayName || city.name)}</div>
            <div class="card-meta">${city.isGeo ? 'Текущее местоположение' : 'Город'}</div>
          </div>
          <div class="card-actions"><button class="btn remove-card">Удалить</button></div>
        </div>
        <div class="card-body"><p class="loading">Загрузка...</p></div>
      `;
      const rem = wrapper.querySelector('.remove-card');
      rem.addEventListener('click', () => {
        const wasGeo = this.cities.find(c => c.id === city.id && c.isGeo);
        this.cities = this.cities.filter(c => c.id !== city.id);
        storage.set('cities', this.cities);
        this.renderAll();
        if (wasGeo) this._refreshHeader();
      });
      return wrapper;
    }

    async _fillCardForecast(city, cardEl) {
      const body = cardEl.querySelector('.card-body'); if (!body) return;
      body.innerHTML = `<p class="loading">Загрузка...</p>`;
      try {
        let { lat, lon } = city;
        if ((!lat || !lon) && !city.isGeo) {
          const geoResp = await apiGeocode(city.name, 1);
          if (!geoResp.results || geoResp.results.length === 0) { body.innerHTML = `<p class="error">Город не найден.</p>`; return; }
          const g = geoResp.results[0]; lat = g.latitude; lon = g.longitude; city.lat = lat; city.lon = lon; storage.set('cities', this.cities);
        }
        const fx = await apiForecast(lat, lon, 3);
        const times = (fx.daily && fx.daily.time) ? fx.daily.time : [];
        const tmin = (fx.daily && fx.daily.temperature_2m_min) ? fx.daily.temperature_2m_min : [];
        const tmax = (fx.daily && fx.daily.temperature_2m_max) ? fx.daily.temperature_2m_max : [];
        const codes = (fx.daily && fx.daily.weathercode) ? fx.daily.weathercode : [];
        let html = '';
        for (let i = 0; i < 3; i++) {
          const label = (i === 0 ? 'Сегодня' : i === 1 ? 'Завтра' : 'Послезавтра');
          const timeVal = times[i] || null;
          const minV = (typeof tmin[i] !== 'undefined') ? Math.round(tmin[i]) : '—';
          const maxV = (typeof tmax[i] !== 'undefined') ? Math.round(tmax[i]) : '—';
          const text = (typeof codes[i] !== 'undefined' && WEATHER_MAP[codes[i]]) ? WEATHER_MAP[codes[i]] : '—';
          html += `<div class="day"><div><b>${label}${timeVal ? ` (${formatHumanDate(timeVal)})` : ''}:</b><div class="desc">${escapeHtml(text)}</div></div><div class="temps">${minV}°C — ${maxV}°C</div></div>`;
        }
        body.innerHTML = html;
      } catch (err) { console.error('fillCardForecast error', err); body.innerHTML = `<p class="error">Ошибка загрузки: ${escapeHtml(err.message || 'ошибка')}</p>`; }
    }

    async refreshAllCards() {
      const cards = document.querySelectorAll('.weather-card');
      for (const card of cards) {
        const id = card.dataset.id; const city = this.cities.find(c => c.id === id);
        if (city) await this._fillCardForecast(city, card);
      }
    }

    _getCurrentPosition(options = {}) {
      return new Promise((resolve, reject) => {
        if (!navigator.geolocation) return reject(new Error('Геолокация не поддерживается'));
        navigator.geolocation.getCurrentPosition(resolve, reject, options);
      });
    }

    async addOrUpdateGeo(showErrors = true) {
      try {
        const pos = await this._getCurrentPosition({ timeout: DEFAULTS.GEO_TIMEOUT_MS });
        const lat = pos.coords.latitude; const lon = pos.coords.longitude;

        let display = null;
        try {
          const rev = await apiGeocodeReverse(lat, lon, 1);
          if (rev && rev.results && rev.results[0]) {
            const r = rev.results[0];
            display = `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}${r.country ? ', ' + r.country : ''}`;
          }
        } catch (e) { /* reverse geocode already safe, but keep silence */ }

        if (!display) display = 'Текущее местоположение';

        const existing = Array.isArray(this.cities) ? this.cities.find(c => c.isGeo) : undefined;
        if (existing) {
          existing.lat = lat; existing.lon = lon; existing.displayName = display;
          storage.set('cities', this.cities); this.renderAll();
        } else {
          const geoItem = { id: uid(), name: 'geo', displayName: display, lat, lon, isGeo: true };
          this.cities.unshift(geoItem); storage.set('cities', this.cities); this.renderAll();
        }
        this._refreshHeader();
        if (this.dom.error) this.dom.error.textContent = '';
      } catch (err) {
        console.warn('addOrUpdateGeo error', err);
        if (!showErrors) return;
        if (err && err.code === 1 && this.dom.error) this.dom.error.textContent = 'Доступ к геопозиции запрещён';
        else if (this.dom.error) this.dom.error.textContent = 'Не удалось получить геопозицию';
      }
    }

    _refreshHeader() {
      const geo = Array.isArray(this.cities) ? this.cities.find(c => c.isGeo) : null;
      if (this.dom.headerLocation) {
        if (geo) this.dom.headerLocation.textContent = `Местоположение: ${geo.displayName || 'Текущее местоположение'}`;
        else this.dom.headerLocation.textContent = '';
      }
    }

    async start() {
      if ((!this.cities || this.cities.length === 0) && navigator.geolocation) {
        try { await this.addOrUpdateGeo(false); } catch (e) { /* ignore */ }
      }
      this.renderAll();
    }
  }

  return new WeatherApp();
})();

document.addEventListener('DOMContentLoaded', () => { if (typeof App.start === 'function') App.start(); });
