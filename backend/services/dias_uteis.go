package services

import "time"

// DiasUteisEntre conta dias úteis (segunda a sexta) estritamente entre duas datas
// (não inclui o dia de início, inclui o dia de fim). Não considera feriados —
// não existe calendário de feriados no banco hoje; é uma limitação conhecida.
func DiasUteisEntre(inicio, fim time.Time) int {
	if !fim.After(inicio) {
		return 0
	}
	inicio = truncateToDay(inicio)
	fim = truncateToDay(fim)
	dias := 0
	for d := inicio.AddDate(0, 0, 1); !d.After(fim); d = d.AddDate(0, 0, 1) {
		wd := d.Weekday()
		if wd != time.Saturday && wd != time.Sunday {
			dias++
		}
	}
	return dias
}

// DiasCorridosEntre conta dias corridos (calendário) estritamente entre duas datas.
func DiasCorridosEntre(inicio, fim time.Time) int {
	if !fim.After(inicio) {
		return 0
	}
	inicio = truncateToDay(inicio)
	fim = truncateToDay(fim)
	return int(fim.Sub(inicio).Hours() / 24)
}

func truncateToDay(t time.Time) time.Time {
	return time.Date(t.Year(), t.Month(), t.Day(), 0, 0, 0, 0, t.Location())
}
