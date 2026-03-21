package handlers

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/gin-gonic/gin"
)

type mlProxyRequest struct {
	Features map[string]interface{} `json:"features"`
}

type mlProxyResponse struct {
	Status int
	Body   []byte
}

func callMLService(path string, payload interface{}) (*mlProxyResponse, error) {
	client := &http.Client{Timeout: 6 * time.Second}
	buf, _ := json.Marshal(payload)

	resp, err := client.Post("http://localhost:8001"+path, "application/json", bytes.NewBuffer(buf))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, _ := ioReadAll(resp.Body)
	return &mlProxyResponse{Status: resp.StatusCode, Body: body}, nil
}

// GET /api/v1/processo/:id/predict-status
func PredictStatusML(c *gin.Context) {
	var req mlProxyRequest
	_ = c.ShouldBindJSON(&req)
	if req.Features == nil {
		req.Features = map[string]interface{}{}
	}
	// permite incluir id do processo como feature
	if pid := c.Param("id"); pid != "" {
		if _, ok := req.Features["processo_id"]; !ok {
			req.Features["processo_id"] = pid
		}
	}
	resp, err := callMLService("/predict/status", req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Falha ao chamar ML", "detail": err.Error()})
		return
	}
	c.Data(resp.Status, "application/json", resp.Body)
}

// POST /api/v1/detect/anomaly
func PredictAnomalyML(c *gin.Context) {
	var req mlProxyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "features obrigatorias"})
		return
	}
	resp, err := callMLService("/predict/anomaly", req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Falha ao chamar ML", "detail": err.Error()})
		return
	}
	c.Data(resp.Status, "application/json", resp.Body)
}

// POST /api/v1/predict/sla
func PredictSLAML(c *gin.Context) {
	var req mlProxyRequest
	if err := c.ShouldBindJSON(&req); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "features obrigatorias"})
		return
	}
	resp, err := callMLService("/predict/sla", req)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "Falha ao chamar ML", "detail": err.Error()})
		return
	}
	c.Data(resp.Status, "application/json", resp.Body)
}

// small helper to avoid extra import conflicts
func ioReadAll(r io.Reader) ([]byte, error) {
	buf := new(bytes.Buffer)
	_, err := buf.ReadFrom(r)
	return buf.Bytes(), err
}
