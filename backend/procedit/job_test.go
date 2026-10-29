package procedit

import "testing"

func TestInterpretarJobAgua(t *testing.T) {
	msg := "rode agua_sync.py que esta em .\ressarcimento_system\terefas me traga o resultado de quantas faturas foram inseridas as empresas são as 4 14 32 33 42 69 80 120 144 154 180 183 189 191 202 203 204 205 206 207 208 209 210 212 214 216 217 218 219 223 224 359 362 363 366 367 371 374 375"
	p, ok := interpretar(msg)
	if !ok || p.op != "rodar_job" || p.params["job"] != "agua_sync" {
		t.Fatalf("esperava rodar_job agua_sync, veio %+v ok=%v", p, ok)
	}
	if got := p.params["empresas"]; got != "4,14,32,33,42,69,80,120,144,154,180,183,189,191,202,203,204,205,206,207,208,209,210,212,214,216,217,218,219,223,224,359,362,363,366,367,371,374,375" {
		t.Errorf("empresas = %q", got)
	}
	if !EhComando(msg) {
		t.Errorf("deveria ser comando")
	}
	if p2, ok2 := interpretar("sincronizar as faturas de água"); !ok2 || p2.op != "rodar_job" || p2.params["empresas"] != "" {
		t.Errorf("sem lista: %+v", p2)
	}
	if EhLeitura(msg, &Acao{Op: "rodar_job"}) {
		t.Errorf("rodar_job não é leitura")
	}
}
