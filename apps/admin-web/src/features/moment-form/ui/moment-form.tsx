import { useForm } from '@tanstack/react-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { InferRequestType } from 'hono/client';
import { useEffect, useRef, useState } from 'react';

import {
  type Fastener,
  type FastenerColor,
  type Moment,
  type MomentStatus,
  fastenerColorOptions,
  fastenerOptions,
  momentKeys,
  momentStatusLabels,
} from '@/entities/moment';
import { client } from '@/shared/api';
import { cn, formatDateTime } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';

import { type CapturedAt, capturedAtSourceLabels, readCapturedAt } from '../lib/captured-at';
import { compressImage } from '../lib/compress-image';
import { buildPreviewUrl } from '../lib/preview-url';
import { uploadImages } from '../lib/upload-image';
import { MOMENT_TEXT_MAX, momentFormSchema } from '../model/schema';

type CreateMomentInput = InferRequestType<typeof client.api.moments.$post>['json'];
type UpdateMomentInput = InferRequestType<(typeof client.api.moments)[':id']['$patch']>['json'];

const swatchClasses: Record<FastenerColor, string> = {
  pink: 'bg-pink-300',
  blue: 'bg-sky-300',
  yellow: 'bg-yellow-300',
  green: 'bg-green-300',
};

interface MomentFormProps {
  /** 指定すると編集モード。省略時は新規投稿 */
  moment?: Moment;
}

export function MomentForm({ moment }: MomentFormProps) {
  const isEdit = moment !== undefined;
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [file, setFile] = useState<File | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [fastener, setFastener] = useState<Fastener>(moment?.fastener ?? 'clip');
  const [fastenerColor, setFastenerColor] = useState<FastenerColor | null>(
    moment?.fastenerColor ?? null,
  );
  const [status, setStatus] = useState<MomentStatus>(moment?.status ?? 'published');
  // 選択中ファイルの撮影時刻 (EXIF から補完)。表示用。null は未選択 or 読み取り中
  const [captured, setCaptured] = useState<CapturedAt | null>(null);
  // 送信の進行段階。画像アップロードとレコード保存のどちらを待っているかを表示し、
  // 全区間でボタンを無効化する (mutation 中だけの無効化だとアップロード中に再送信できてしまう)
  const [submitPhase, setSubmitPhase] = useState<'idle' | 'uploading' | 'saving'>('idle');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  // 同じファイルの圧縮 + アップロードは一度だけ行う (プレビュー → 投稿で再利用)
  const uploadedRef = useRef<{ file: File; imageKey: string } | null>(null);
  // 撮影時刻の EXIF 解析も同様にファイルごとに一度だけ (表示 → 投稿で同じ値を使う)
  const capturedRef = useRef<{ file: File; value: CapturedAt } | null>(null);
  // 連続でファイルを選び直したとき、古い解析結果で表示を上書きしないための目印
  const latestFileRef = useRef<File | null>(null);
  // ボタン無効化は再レンダリング後にしか効かないため、同一ティック内の連打はここで弾く
  const submittingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  const selectFile = (next: File | null) => {
    latestFileRef.current = next;
    setFile(next);
    setObjectUrl((prev) => {
      if (prev !== null) URL.revokeObjectURL(prev);
      return next !== null ? URL.createObjectURL(next) : null;
    });
    setCaptured(null);
    if (next !== null) {
      void ensureCapturedAt(next).then((value) => {
        if (latestFileRef.current === next) setCaptured(value);
      });
    }
  };

  const selectFastener = (next: Fastener) => {
    setFastener(next);
    setFastenerColor(next === 'tape' ? 'pink' : null);
  };

  const ensureUploaded = async (target: File): Promise<string> => {
    if (uploadedRef.current !== null && uploadedRef.current.file === target) {
      return uploadedRef.current.imageKey;
    }
    const images = await compressImage(target);
    const imageKey = await uploadImages(images);
    uploadedRef.current = { file: target, imageKey };
    return imageKey;
  };

  const ensureCapturedAt = async (target: File): Promise<CapturedAt> => {
    if (capturedRef.current !== null && capturedRef.current.file === target) {
      return capturedRef.current.value;
    }
    const value = await readCapturedAt(target);
    capturedRef.current = { file: target, value };
    return value;
  };

  // 編集では画像の差し替えは任意。新しいファイル未選択なら既存の imageKey を使う
  const resolveImageKey = async (): Promise<string | null> => {
    if (file !== null) return ensureUploaded(file);
    if (isEdit) return moment.imageKey;
    return null;
  };

  // 撮影時刻も同様に、新しいファイルがあれば EXIF から補完、未選択なら既存値を使う
  const resolveCapturedAt = async (): Promise<string | null> => {
    if (file !== null) return (await ensureCapturedAt(file)).iso;
    if (isEdit) return moment.capturedAt;
    return null;
  };

  const createMutation = useMutation({
    mutationFn: async (json: CreateMomentInput) => {
      const res = await client.api.moments.$post({ json });
      if (!res.ok) throw new Error('投稿に失敗しました');
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: momentKeys.all });
      await navigate({ to: '/moments' });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (input: { momentId: string; json: UpdateMomentInput }) => {
      const res = await client.api.moments[':id'].$patch({
        param: { id: input.momentId },
        json: input.json,
      });
      if (!res.ok) throw new Error('更新に失敗しました');
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: momentKeys.all });
      await navigate({ to: '/moments' });
    },
  });

  const isSubmitting = submitPhase !== 'idle';

  const form = useForm({
    defaultValues: { text: moment?.text ?? '' },
    onSubmit: async ({ value }) => {
      if (submittingRef.current) return;
      submittingRef.current = true;
      setSubmitError(null);
      setSubmitPhase('uploading');
      try {
        const imageKey = await resolveImageKey();
        const capturedAt = await resolveCapturedAt();
        if (imageKey === null || capturedAt === null) {
          setSubmitError('写真を選択してください');
          return;
        }
        setSubmitPhase('saving');
        const text = value.text.trim();
        if (isEdit) {
          await updateMutation.mutateAsync({
            momentId: moment.momentId,
            json: {
              text,
              imageKey,
              fastener,
              // clip へ変更した場合などに残った色をサーバー側でも確実に消す
              fastenerColor: fastener === 'tape' ? fastenerColor : null,
              status,
              // 写真を差し替えたときだけ撮影時刻を更新する
              ...(file !== null ? { capturedAt } : {}),
            },
          });
        } else {
          await createMutation.mutateAsync({
            text,
            imageKey,
            fastener,
            ...(fastenerColor !== null ? { fastenerColor } : {}),
            status,
            capturedAt,
          });
        }
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : '送信に失敗しました');
      } finally {
        submittingRef.current = false;
        setSubmitPhase('idle');
      }
    },
  });

  const handlePreview = async () => {
    setSubmitError(null);
    setIsPreviewing(true);
    try {
      const imageKey = await resolveImageKey();
      const capturedAt = await resolveCapturedAt();
      if (imageKey === null || capturedAt === null) {
        setSubmitError('写真を選択してください');
        return;
      }
      const url = buildPreviewUrl({
        imageKey,
        text: form.state.values.text,
        fastener,
        fastenerColor,
        capturedAt,
      });
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'プレビューに失敗しました');
    } finally {
      setIsPreviewing(false);
    }
  };

  // 新しいファイル選択中はそのプレビュー、編集で未選択なら現在の画像
  const previewSrc = objectUrl ?? moment?.imageUrl ?? null;

  // 送信ボタンの表示。進行中はどの処理を待っているかを示す
  const submitLabel = (() => {
    if (submitPhase === 'uploading') return '画像アップロード中…';
    if (submitPhase === 'saving') return isEdit ? '更新を保存中…' : '投稿を保存中…';
    if (isEdit) return '更新する';
    return status === 'draft' ? '下書き保存' : '投稿する';
  })();

  return (
    <form
      className="flex flex-col gap-6"
      data-testid="moment-form"
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void form.handleSubmit();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="moment-image">
          {isEdit ? '写真 (変更する場合のみ選択)' : '写真 (必須)'}
        </Label>
        <input
          id="moment-image"
          type="file"
          accept="image/*"
          className="text-sm"
          data-testid="moment-form-image"
          onChange={(e) => selectFile(e.target.files?.[0] ?? null)}
        />
        {previewSrc !== null && (
          <img
            src={previewSrc}
            alt={objectUrl !== null ? '選択した写真のプレビュー' : '現在の写真'}
            className="max-h-64 w-fit rounded-md border object-contain"
          />
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Label>撮影日時 (写真の下に表示)</Label>
        <p className="text-sm" data-testid="moment-form-captured-at">
          {file !== null
            ? captured !== null
              ? `${formatDateTime(captured.iso)} (${capturedAtSourceLabels[captured.source]})`
              : '読み取り中…'
            : isEdit
              ? formatDateTime(moment.capturedAt)
              : '写真を選択すると自動で設定されます'}
        </p>
        <p className="text-xs text-muted-foreground">
          写真の EXIF から補完します。EXIF がなければファイルの更新日時になります
        </p>
      </div>

      <form.Field
        name="text"
        validators={{
          onChange: ({ value }) => {
            const result = momentFormSchema.shape.text.safeParse(value);
            return result.success ? undefined : result.error.issues[0]?.message;
          },
        }}
      >
        {(field) => (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="moment-text">本文</Label>
              <span
                className={cn(
                  'text-xs text-muted-foreground',
                  field.state.value.length > MOMENT_TEXT_MAX && 'text-destructive',
                )}
                data-testid="moment-form-text-count"
              >
                {field.state.value.length}/{MOMENT_TEXT_MAX}
              </span>
            </div>
            <Textarea
              id="moment-text"
              rows={4}
              value={field.state.value}
              onBlur={field.handleBlur}
              onChange={(e) => field.handleChange(e.target.value)}
              aria-invalid={field.state.meta.errors.length > 0}
              data-testid="moment-form-text"
            />
            {field.state.meta.errors.length > 0 && (
              <p className="text-sm text-destructive" data-testid="moment-form-text-error">
                {String(field.state.meta.errors[0])}
              </p>
            )}
          </div>
        )}
      </form.Field>

      <div className="flex flex-col gap-2">
        <Label>留め具</Label>
        <div className="flex gap-2">
          {fastenerOptions.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={fastener === option.value ? 'default' : 'outline'}
              onClick={() => selectFastener(option.value)}
              data-testid={`moment-form-fastener-${option.value}`}
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>

      {fastener === 'tape' && (
        <div className="flex flex-col gap-2">
          <Label>テープの色</Label>
          <div className="flex gap-3">
            {fastenerColorOptions.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-label={option.label}
                aria-pressed={fastenerColor === option.value}
                className={cn(
                  'size-8 rounded-full border',
                  swatchClasses[option.value],
                  fastenerColor === option.value && 'ring-2 ring-ring ring-offset-2',
                )}
                onClick={() => setFastenerColor(option.value)}
                data-testid={`moment-form-color-${option.value}`}
              />
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <Label>ステータス</Label>
        <div className="flex gap-2">
          {(['published', 'draft'] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={status === value ? 'default' : 'outline'}
              onClick={() => setStatus(value)}
              data-testid={`moment-form-status-${value}`}
            >
              {momentStatusLabels[value]}
            </Button>
          ))}
        </div>
      </div>

      {submitError !== null && (
        <p className="text-sm text-destructive" data-testid="moment-form-error">
          {submitError}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => void handlePreview()}
          disabled={isPreviewing || isSubmitting}
          data-testid="moment-form-preview"
        >
          {isPreviewing ? '画像アップロード中…' : 'プレビュー'}
        </Button>
        <Button
          type="submit"
          disabled={isSubmitting || isPreviewing}
          data-testid="moment-form-submit"
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
