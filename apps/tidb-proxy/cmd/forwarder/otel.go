// OpenTelemetry 計装のセットアップ。
//
// 同一 Fargate task 内の ADOT Collector sidecar (localhost:4317) へ OTLP/gRPC で
// traces / metrics を送る。Collector 側で traces は X-Ray へ、metrics は
// CloudWatch OTel Metrics (OTLP ネイティブ) へ export する。
//
// OTEL_EXPORTER_OTLP_ENDPOINT 未設定時は noop provider にフォールバックし、
// 計装コードはそのまま (コストほぼゼロで) 動く。ローカル実行を壊さないため。
package main

import (
	"context"
	cryptorand "crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/contrib/propagators/aws/xray"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetricgrpc"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracegrpc"
	"go.opentelemetry.io/otel/metric"
	metricnoop "go.opentelemetry.io/otel/metric/noop"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
	tracenoop "go.opentelemetry.io/otel/trace/noop"
)

const (
	envOtelEndpoint    = "OTEL_EXPORTER_OTLP_ENDPOINT"
	envOtelServiceName = "OTEL_SERVICE_NAME"

	defaultOtelServiceName = "tidb-proxy"
	instrumentationScope   = "tidb-proxy/forwarder"
)

type telemetry struct {
	tracer   trace.Tracer
	shutdown func(context.Context) error

	// proxy.upstream.name 属性に使う論理名 (例: "tidb")
	upstreamName string

	activeConns        atomic.Int64
	acceptCount        metric.Int64Counter
	upstreamConnectDur metric.Float64Histogram
	connectionDur      metric.Float64Histogram
	bytesIn            metric.Int64Counter
	bytesOut           metric.Int64Counter
	errorCount         metric.Int64Counter
	timeoutCount       metric.Int64Counter
}

// setupTelemetry は OTel SDK を初期化する。endpoint 未設定なら noop。
func setupTelemetry(ctx context.Context, upstreamName string) (*telemetry, error) {
	tel := &telemetry{upstreamName: upstreamName}

	endpoint := strings.TrimSpace(os.Getenv(envOtelEndpoint))
	if endpoint == "" {
		tel.tracer = tracenoop.NewTracerProvider().Tracer(instrumentationScope)
		if err := tel.initInstruments(metricnoop.NewMeterProvider().Meter(instrumentationScope)); err != nil {
			return nil, err
		}
		tel.shutdown = func(context.Context) error { return nil }
		log.Printf("otel: disabled (%s not set)", envOtelEndpoint)
		return tel, nil
	}

	serviceName := getenv(envOtelServiceName, defaultOtelServiceName)
	// デプロイのローリング中は同一 service.name の task が並行するため、
	// service.instance.id でプロセスごとに cumulative 系列を分離する。
	res, err := resource.New(ctx,
		resource.WithFromEnv(),
		resource.WithTelemetrySDK(),
		resource.WithAttributes(
			attribute.String("service.name", serviceName),
			attribute.String("service.instance.id", newInstanceID()),
		),
	)
	if err != nil {
		return nil, fmt.Errorf("otel resource: %w", err)
	}

	traceExporter, err := otlptracegrpc.New(ctx)
	if err != nil {
		return nil, fmt.Errorf("otlp trace exporter: %w", err)
	}
	// awsxray exporter が受理できるよう X-Ray 互換の trace ID を生成する。
	tracerProvider := sdktrace.NewTracerProvider(
		sdktrace.WithBatcher(traceExporter),
		sdktrace.WithResource(res),
		sdktrace.WithIDGenerator(xray.NewIDGenerator()),
	)

	// temporality はデフォルトの cumulative。CloudWatch OTel Metrics を PromQL
	// (rate / histogram_quantile) で読む前提のため Prometheus 同様 cumulative が正。
	metricExporter, err := otlpmetricgrpc.New(ctx)
	if err != nil {
		return nil, fmt.Errorf("otlp metric exporter: %w", err)
	}
	meterProvider := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(
			sdkmetric.NewPeriodicReader(metricExporter, sdkmetric.WithInterval(15*time.Second)),
		),
	)

	otel.SetTracerProvider(tracerProvider)
	otel.SetMeterProvider(meterProvider)

	tel.tracer = tracerProvider.Tracer(instrumentationScope)
	if err := tel.initInstruments(meterProvider.Meter(instrumentationScope)); err != nil {
		return nil, err
	}
	tel.shutdown = func(ctx context.Context) error {
		return errors.Join(tracerProvider.Shutdown(ctx), meterProvider.Shutdown(ctx))
	}

	log.Printf("otel: enabled endpoint=%s service=%s", endpoint, serviceName)
	return tel, nil
}

func (t *telemetry) initInstruments(meter metric.Meter) error {
	// CloudWatch のパーセンタイルは bucket 境界で量子化されるため、想定レンジを
	// 細かめに切る。connect は数 ms 〜 数秒、connection lifetime は秒〜時間。
	latencyBoundaries := metric.WithExplicitBucketBoundaries(
		1, 2, 5, 10, 20, 30, 50, 75, 100, 150, 200, 300, 500, 750,
		1000, 1500, 2000, 3000, 5000, 10000, 30000,
	)
	lifetimeBoundaries := metric.WithExplicitBucketBoundaries(
		10, 100, 500, 1000, 5000, 15000, 60000, 300000, 900000, 1800000, 3600000,
	)

	var errs []error

	acceptCount, err := meter.Int64Counter("proxy.connection.accept.count",
		metric.WithDescription("Accepted downstream connections"))
	errs = append(errs, err)
	t.acceptCount = acceptCount

	upstreamConnectDur, err := meter.Float64Histogram("proxy.upstream.connect.duration",
		metric.WithDescription("Upstream (tsnet dial) connect latency"),
		metric.WithUnit("ms"), latencyBoundaries)
	errs = append(errs, err)
	t.upstreamConnectDur = upstreamConnectDur

	connectionDur, err := meter.Float64Histogram("proxy.connection.duration",
		metric.WithDescription("Proxied connection lifetime"),
		metric.WithUnit("ms"), lifetimeBoundaries)
	errs = append(errs, err)
	t.connectionDur = connectionDur

	bytesIn, err := meter.Int64Counter("proxy.bytes.in",
		metric.WithDescription("Bytes from downstream (Lambda) to upstream"),
		metric.WithUnit("By"))
	errs = append(errs, err)
	t.bytesIn = bytesIn

	bytesOut, err := meter.Int64Counter("proxy.bytes.out",
		metric.WithDescription("Bytes from upstream to downstream (Lambda)"),
		metric.WithUnit("By"))
	errs = append(errs, err)
	t.bytesOut = bytesOut

	errorCount, err := meter.Int64Counter("proxy.error.count",
		metric.WithDescription("Proxy-level errors"))
	errs = append(errs, err)
	t.errorCount = errorCount

	timeoutCount, err := meter.Int64Counter("proxy.timeout.count",
		metric.WithDescription("Upstream connect timeouts"))
	errs = append(errs, err)
	t.timeoutCount = timeoutCount

	activeGauge, err := meter.Int64ObservableGauge("proxy.connection.active",
		metric.WithDescription("Active proxied connections"))
	errs = append(errs, err)
	if err == nil {
		_, cbErr := meter.RegisterCallback(func(_ context.Context, o metric.Observer) error {
			o.ObserveInt64(activeGauge, t.activeConns.Load())
			return nil
		}, activeGauge)
		errs = append(errs, cbErr)
	}

	return errors.Join(errs...)
}

// newInstanceID はプロセス単位の識別子 (128bit hex) を返す。
func newInstanceID() string {
	b := make([]byte, 16)
	if _, err := cryptorand.Read(b); err != nil {
		return fmt.Sprintf("pid-%d-%d", os.Getpid(), time.Now().UnixNano())
	}
	return hex.EncodeToString(b)
}
