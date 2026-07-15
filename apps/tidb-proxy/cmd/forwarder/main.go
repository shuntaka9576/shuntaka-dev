// tidb-proxy forwarder は Fargate task のメインプロセスとして起動し、
//
//  1. 環境変数 TS_AUTHKEY (reusable / non-ephemeral / tag:proxy で発行済み)
//     を使って tsnet.Server で Tailnet に join
//  2. 各 forward ルールを TCP forward する。TiDB (必須) は
//     0.0.0.0:13306 -> tidb.<suffix>:4000、PLaMo (PLAMO_HOSTNAME 設定時) は
//     0.0.0.0:18080 -> plamo-embedding.<suffix>:80 を公開し、Lambda から
//     Tailnet 上のサービスへ VPC 内エンドポイント経由で到達させる
//
// alpine ベース image で動かす前提で CGO_ENABLED=0 で static build する。
//
// blog-api/tsnet-launcher との差分:
//   - SSM Parameter Store / OAuth client_credentials による auth key 発行を削除
//     (常駐 proxy なので reusable / non-ephemeral / tagged な auth key を
//     ecspresso 経由で SSM から runtime fetch する想定)
//   - Rust HTTP server を子プロセス起動するロジックを削除 (forwarder のみ)
//   - listen を 127.0.0.1 ではなく 0.0.0.0 にして同 VPC 内 Lambda から到達可能に
//   - state dir を /var/lib/tsnet-state (コンテナ内の通常パス) に変更
package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"strconv"
	"sync"
	"syscall"
	"time"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/trace"
	"tailscale.com/tsnet"
)

const (
	envTSAuthKey         = "TS_AUTHKEY"
	envTailnetSuffix     = "TAILNET_SUFFIX"
	envTsnetHostname     = "TSNET_HOSTNAME"
	envForwardListenAddr = "FORWARD_LISTEN_ADDR"
	envTidbHostname      = "TIDB_HOSTNAME"
	envTidbPort          = "TIDB_PORT"
	envTsnetStateDir     = "TSNET_STATE_DIR"
	envPlamoHostname     = "PLAMO_HOSTNAME"
	envPlamoPort         = "PLAMO_PORT"
	envPlamoListenAddr   = "PLAMO_LISTEN_ADDR"

	defaultTsnetHostname     = "tidb-proxy"
	defaultForwardListenAddr = "0.0.0.0:13306"
	defaultTidbHostname      = "tidb"
	defaultTidbPort          = "4000"
	defaultTsnetStateDir     = "/var/lib/tsnet-state"
	defaultPlamoListenAddr   = "0.0.0.0:18080"
	defaultPlamoPort         = "80"
)

// forwardRule は 1 本の TCP forward (listen -> tsnet 上の upstream) を表す。
type forwardRule struct {
	ListenAddr string
	// Target は "host.<suffix>:port" 形式の tsnet 上の upstream。
	Target string
	// UpstreamName は Target のホスト論理名 (例: "tidb" / "plamo-embedding")。
	// span/metric の proxy.upstream.name 属性に使う。
	UpstreamName string
}

type forwarderConfig struct {
	AuthKey  string
	Hostname string
	StateDir string
	// Forwards は起動する forward ルール群。TiDB は必須、PLaMo は
	// PLAMO_HOSTNAME 設定時のみ追加する。
	Forwards []forwardRule
}

func main() {
	setupLogger()

	cfg, err := loadConfig()
	if err != nil {
		fatal("loadConfig", "error", err)
	}
	slog.Info("config loaded",
		"hostname", cfg.Hostname, "forwards", len(cfg.Forwards), "state_dir", cfg.StateDir)

	if err := os.MkdirAll(cfg.StateDir, 0o700); err != nil {
		fatal("mkdir state dir", "dir", cfg.StateDir, "error", err)
	}

	ts := &tsnet.Server{
		Hostname:  cfg.Hostname,
		AuthKey:   cfg.AuthKey,
		Dir:       cfg.StateDir,
		Ephemeral: false,
	}
	defer ts.Close()

	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	tel, err := setupTelemetry(ctx)
	if err != nil {
		fatal("setupTelemetry", "error", err)
	}

	if _, err := ts.Up(ctx); err != nil {
		fatal("tsnet.Up", "error", err)
	}
	slog.Info("tsnet up", "hostname", cfg.Hostname)

	// ts.Dial は tsnet 内部 dialer 経由で netmap に居る peer の MagicDNS 名を解決する。
	// ACL で tag:proxy -> tag:k8s (Operator Proxy) が許可されていれば
	// `tidb.<suffix>` / `plamo-embedding.<suffix>` が解決可能になる。未許可だと
	// netmap に peer が無く OS resolver にフォールバックして NXDOMAIN になるので、
	// ACL 設定漏れに注意。
	var listeners []net.Listener
	defer func() {
		for _, l := range listeners {
			_ = l.Close()
		}
	}()
	for _, rule := range cfg.Forwards {
		listener, err := net.Listen("tcp", rule.ListenAddr)
		if err != nil {
			fatal("listen", "addr", rule.ListenAddr, "error", err)
		}
		listeners = append(listeners, listener)
		slog.Info("forwarder listening",
			"listen", listener.Addr().String(),
			"target", rule.Target, "upstream", rule.UpstreamName)
		go runForwarder(ts, listener, rule.Target, tel, rule.UpstreamName)

		// Pre-warm DERP / DNS by dialing each upstream once.
		prewarmCtx, prewarmCancel := context.WithTimeout(ctx, 10*time.Second)
		if conn, err := ts.Dial(prewarmCtx, "tcp", rule.Target); err == nil {
			_ = conn.Close()
			slog.Info("pre-warm dial ok", "target", rule.Target)
		} else {
			slog.Warn("pre-warm dial failed", "target", rule.Target, "error", err)
		}
		prewarmCancel()
	}

	<-ctx.Done()
	slog.Info("shutdown signal received, exiting")

	// 溜まっている traces / metrics を送り切ってから終了する。
	shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := tel.shutdown(shutdownCtx); err != nil {
		slog.Warn("otel shutdown", "error", err)
	}
	shutdownCancel()
}

// setupLogger は default logger を JSON (slog) に差し替える。
// キー名は FireLens (Fluent Bit) の振り分けと Iceberg テーブルのスキーマに合わせて
// ts / level / message に統一し、log_type=forwarder を全行に付与する。
// tsnet 内部ログは標準 log (プレーンテキスト) のまま stderr に出るが、Fluent Bit の
// JSON パースに失敗して CloudWatch Logs 側へフォールバックするので、それで良い。
func setupLogger() {
	logger := slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
		ReplaceAttr: func(_ []string, a slog.Attr) slog.Attr {
			switch a.Key {
			case slog.TimeKey:
				a.Key = "ts"
			case slog.MessageKey:
				a.Key = "message"
			}
			return a
		},
	})).With(slog.String("log_type", "forwarder"))
	slog.SetDefault(logger)
}

// fatal は起動時の致命的エラーを ERROR で出してから終了する (log.Fatalf 相当)。
func fatal(msg string, args ...any) {
	slog.Error(msg, args...)
	os.Exit(1)
}

func loadConfig() (*forwarderConfig, error) {
	authKey := os.Getenv(envTSAuthKey)
	if authKey == "" {
		return nil, fmt.Errorf("required env missing: %s", envTSAuthKey)
	}
	suffix := os.Getenv(envTailnetSuffix)
	if suffix == "" {
		return nil, fmt.Errorf("required env missing: %s", envTailnetSuffix)
	}

	hostname := getenv(envTsnetHostname, defaultTsnetHostname)
	stateDir := getenv(envTsnetStateDir, defaultTsnetStateDir)

	// TiDB forward は常に張る (blog-api の MySQL 経路)。
	tidbHost := getenv(envTidbHostname, defaultTidbHostname)
	forwards := []forwardRule{
		{
			ListenAddr:   getenv(envForwardListenAddr, defaultForwardListenAddr),
			Target:       fmt.Sprintf("%s.%s:%s", tidbHost, suffix, getenv(envTidbPort, defaultTidbPort)),
			UpstreamName: tidbHost,
		},
	}

	// PLaMo Embedding Service forward は PLAMO_HOSTNAME が設定された時だけ張る
	// (Vector 検索の本番経路)。未設定の環境では TiDB のみで後方互換。
	if plamoHost := os.Getenv(envPlamoHostname); plamoHost != "" {
		forwards = append(forwards, forwardRule{
			ListenAddr:   getenv(envPlamoListenAddr, defaultPlamoListenAddr),
			Target:       fmt.Sprintf("%s.%s:%s", plamoHost, suffix, getenv(envPlamoPort, defaultPlamoPort)),
			UpstreamName: plamoHost,
		})
	}

	return &forwarderConfig{
		AuthKey:  authKey,
		Hostname: hostname,
		StateDir: stateDir,
		Forwards: forwards,
	}, nil
}

func getenv(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func runForwarder(ts *tsnet.Server, listener net.Listener, target string, tel *telemetry, upstreamName string) {
	for {
		conn, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			slog.Error("forwarder accept", "error", err)
			return
		}
		go forwardConn(ts, conn, target, tel, upstreamName)
	}
}

func forwardConn(ts *tsnet.Server, src net.Conn, target string, tel *telemetry, upstreamName string) {
	defer src.Close()

	// ECS ヘルスチェック (nc -z) は同一 task 内の loopback から来る。
	// TCP ハンドシェイク成立時点でチェックは成功しているので、upstream への dial もテレメトリも行わずに閉じる。
	// dial すると即クローズ済みの src への greeting 書き戻しが失敗し、偽の forward_error とトレースノイズになる。
	// 実トラフィック (Lambda) は VPC の private IP から来る。
	if addr, ok := src.RemoteAddr().(*net.TCPAddr); ok && addr.IP.IsLoopback() {
		return
	}

	connStart := time.Now()
	ctx := context.Background()
	upstreamAttr := attribute.String("proxy.upstream.name", upstreamName)

	tel.acceptCount.Add(ctx, 1)
	tel.activeConns.Add(1)
	defer tel.activeConns.Add(-1)

	// proxy.forward span は proxy された TCP 接続 (= MySQL セッション) の一生。
	peerHost, peerPort := splitHostPort(src.RemoteAddr().String())
	forwardCtx, span := tel.tracer.Start(ctx, "proxy.forward",
		trace.WithSpanKind(trace.SpanKindServer),
		trace.WithAttributes(
			attribute.String("net.transport", "ip_tcp"),
			attribute.String("net.peer.ip", peerHost),
			attribute.Int("net.peer.port", peerPort),
			upstreamAttr,
		))
	defer span.End()

	// accept 〜 upstream dial 開始までのハンドオフを示すマーカー span。
	_, acceptSpan := tel.tracer.Start(forwardCtx, "proxy.accept")
	acceptSpan.End()

	dialStart := time.Now()
	dialCtx, cancel := context.WithTimeout(forwardCtx, 5*time.Second)
	connectCtx, connectSpan := tel.tracer.Start(dialCtx, "proxy.upstream.connect",
		trace.WithSpanKind(trace.SpanKindClient),
		trace.WithAttributes(upstreamAttr))
	dst, err := ts.Dial(connectCtx, "tcp", target)
	cancel()
	tel.upstreamConnectDur.Record(ctx, durationMs(dialStart), metric.WithAttributes(upstreamAttr))
	if err != nil {
		errType := "connect_error"
		if errors.Is(err, context.DeadlineExceeded) {
			errType = "connect_timeout"
			tel.timeoutCount.Add(ctx, 1)
		}
		tel.errorCount.Add(ctx, 1,
			metric.WithAttributes(attribute.String("error.type", errType)))
		connectSpan.RecordError(err)
		connectSpan.SetStatus(codes.Error, errType)
		connectSpan.End()
		span.SetAttributes(
			attribute.String("proxy.close.reason", "error"),
			attribute.String("error.type", errType),
		)
		span.SetStatus(codes.Error, errType)
		slog.Warn("forwarder dial failed", "target", target, "error_type", errType, "error", err)
		return
	}
	connectSpan.End()
	defer dst.Close()

	var bytesIn, bytesOut int64
	var errIn, errOut error
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		bytesIn, errIn = io.Copy(dst, src)
		if c, ok := dst.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
	}()
	go func() {
		defer wg.Done()
		bytesOut, errOut = io.Copy(src, dst)
		if c, ok := src.(interface{ CloseWrite() error }); ok {
			_ = c.CloseWrite()
		}
	}()
	wg.Wait()

	reason := closeReason(errIn, errOut)
	reasonAttr := attribute.String("proxy.close.reason", reason)

	tel.bytesIn.Add(ctx, bytesIn, metric.WithAttributes(upstreamAttr))
	tel.bytesOut.Add(ctx, bytesOut, metric.WithAttributes(upstreamAttr))
	tel.connectionDur.Record(ctx, durationMs(connStart),
		metric.WithAttributes(upstreamAttr, reasonAttr))
	if reason == "error" {
		tel.errorCount.Add(ctx, 1,
			metric.WithAttributes(attribute.String("error.type", "forward_error")))
	}

	span.SetAttributes(
		attribute.Int64("proxy.bytes.in", bytesIn),
		attribute.Int64("proxy.bytes.out", bytesOut),
		reasonAttr,
	)
	span.AddEvent("proxy.close", trace.WithAttributes(reasonAttr))
	if reason == "error" {
		span.SetStatus(codes.Error, "forward_error")
	}
}

func durationMs(start time.Time) float64 {
	return float64(time.Since(start)) / float64(time.Millisecond)
}

func splitHostPort(addr string) (string, int) {
	host, portStr, err := net.SplitHostPort(addr)
	if err != nil {
		return addr, 0
	}
	port, _ := strconv.Atoi(portStr)
	return host, port
}

// closeReason は双方向 copy の結果から接続クローズ理由を正規化する。
// 優先度: reset > error > timeout > eof (異常度の高い方を採用する)。
func closeReason(errs ...error) string {
	rank := map[string]int{"eof": 0, "timeout": 1, "error": 2, "reset": 3}
	reason := "eof"
	for _, err := range errs {
		if err == nil {
			continue
		}
		r := "error"
		var netErr net.Error
		if errors.Is(err, syscall.ECONNRESET) {
			r = "reset"
		} else if errors.As(err, &netErr) && netErr.Timeout() {
			r = "timeout"
		}
		if rank[r] > rank[reason] {
			reason = r
		}
	}
	return reason
}
