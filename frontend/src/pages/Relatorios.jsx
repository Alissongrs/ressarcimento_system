import React, { useState } from 'react';
import RelatoriosMetricas from './RelatoriosMetricas.jsx';

export default function Relatorios() {
  const [dataIniDay, setDataIniDay] = useState('');
  const [dataIniMonth, setDataIniMonth] = useState('');
  const [dataIniYear, setDataIniYear] = useState('');
  const [dataFimDay, setDataFimDay] = useState('');
  const [dataFimMonth, setDataFimMonth] = useState('');
  const [dataFimYear, setDataFimYear] = useState('');
  const [filterError, setFilterError] = useState('');
  const [globalFilters, setGlobalFilters] = useState({ dataIni: '', dataFim: '' });

  const parseDateBR = (value) => {
    const s = String(value || '').trim();
    if (!s) return null;
    const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) return null;
    const day = Number(m[1]);
    const month = Number(m[2]);
    const year = Number(m[3]);
    const dt = new Date(year, month - 1, day);
    if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
      return null;
    }
    return dt;
  };

  const buildDateBR = (day, month, year) => {
    if (!day || !month || !year) return '';
    return `${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')}/${year}`;
  };

  const applyGlobalFilters = () => {
    setFilterError('');
    const dataIni = buildDateBR(dataIniDay, dataIniMonth, dataIniYear);
    const dataFim = buildDateBR(dataFimDay, dataFimMonth, dataFimYear);
    if ((dataIni && !dataFim) || (!dataIni && dataFim)) {
      setFilterError('Preencha data inicio e data fim para aplicar o periodo.');
      return;
    }
    if (dataIni && dataFim) {
      const ini = parseDateBR(dataIni);
      const fim = parseDateBR(dataFim);
      if (!ini || !fim) {
        setFilterError('Use o formato dd/mm/aaaa.');
        return;
      }
      if (ini > fim) {
        setFilterError('Data inicio nao pode ser maior que a data fim.');
        return;
      }
    }
    setGlobalFilters({ dataIni: dataIni.trim(), dataFim: dataFim.trim() });
  };

  const days = Array.from({ length: 31 }, (_, i) => i + 1);
  const months = Array.from({ length: 12 }, (_, i) => i + 1);
  const years = Array.from({ length: 11 }, (_, i) => 2018 + i);

  return (
    <div className="p-4 space-y-4">
      <div className="p-4 rounded-lg border panel-border panel-bg-60 space-y-3">
        <div className="text-sm font-semibold">Filtro global por periodo</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="text-xs opacity-70">Data inicio (dd/mm/aaaa)</label>
            <div className="flex gap-2">
              <select
                value={dataIniDay}
                onChange={(e) => setDataIniDay(e.target.value)}
                className="w-20 px-2 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              >
                <option value="">Dia</option>
                {days.map((d) => (
                  <option key={`ini-day-${d}`} value={String(d).padStart(2, '0')}>
                    {String(d).padStart(2, '0')}
                  </option>
                ))}
              </select>
              <select
                value={dataIniMonth}
                onChange={(e) => setDataIniMonth(e.target.value)}
                className="w-24 px-2 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              >
                <option value="">Mes</option>
                {months.map((m) => (
                  <option key={`ini-month-${m}`} value={String(m).padStart(2, '0')}>
                    {String(m).padStart(2, '0')}
                  </option>
                ))}
              </select>
              <select
                value={dataIniYear}
                onChange={(e) => setDataIniYear(e.target.value)}
                className="w-28 px-2 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              >
                <option value="">Ano</option>
                {years.map((y) => (
                  <option key={`ini-year-${y}`} value={String(y)}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs opacity-70">Data fim (dd/mm/aaaa)</label>
            <div className="flex gap-2">
              <select
                value={dataFimDay}
                onChange={(e) => setDataFimDay(e.target.value)}
                className="w-20 px-2 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              >
                <option value="">Dia</option>
                {days.map((d) => (
                  <option key={`fim-day-${d}`} value={String(d).padStart(2, '0')}>
                    {String(d).padStart(2, '0')}
                  </option>
                ))}
              </select>
              <select
                value={dataFimMonth}
                onChange={(e) => setDataFimMonth(e.target.value)}
                className="w-24 px-2 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              >
                <option value="">Mes</option>
                {months.map((m) => (
                  <option key={`fim-month-${m}`} value={String(m).padStart(2, '0')}>
                    {String(m).padStart(2, '0')}
                  </option>
                ))}
              </select>
              <select
                value={dataFimYear}
                onChange={(e) => setDataFimYear(e.target.value)}
                className="w-28 px-2 py-2 border panel-border panel-bg-60 text-[var(--fg)] rounded"
              >
                <option value="">Ano</option>
                {years.map((y) => (
                  <option key={`fim-year-${y}`} value={String(y)}>
                    {y}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="flex items-end gap-2">
            <button
              type="button"
              onClick={applyGlobalFilters}
              className="px-3 py-2 rounded-md border panel-border panel-bg-60 hover:opacity-90"
            >
              Aplicar periodo
            </button>
            <button
              type="button"
              onClick={() => {
                setDataIniDay('');
                setDataIniMonth('');
                setDataIniYear('');
                setDataFimDay('');
                setDataFimMonth('');
                setDataFimYear('');
                setFilterError('');
                setGlobalFilters({ dataIni: '', dataFim: '' });
              }}
              className="px-3 py-2 rounded-md border panel-border panel-bg-60 hover:opacity-90"
            >
              Limpar
            </button>
          </div>
        </div>
        {filterError && <div className="text-xs text-red-500">{filterError}</div>}
      </div>

      <div>
        <RelatoriosMetricas globalFilters={globalFilters} />
      </div>
    </div>
  );
}
