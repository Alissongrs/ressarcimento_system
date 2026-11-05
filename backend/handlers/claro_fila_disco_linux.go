//go:build linux

package handlers

import "syscall"

// espaço livre (GB) no disco da pasta da fila da Claro; -1 se não der para medir
func claroLivreGB(dir string) float64 {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return -1
	}
	return float64(st.Bavail) * float64(st.Bsize) / (1 << 30)
}
