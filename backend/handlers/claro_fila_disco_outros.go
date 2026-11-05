//go:build !linux

package handlers

// fora do Linux (desenvolvimento no Windows) não mede: -1 = desconhecido
func claroLivreGB(dir string) float64 { return -1 }
