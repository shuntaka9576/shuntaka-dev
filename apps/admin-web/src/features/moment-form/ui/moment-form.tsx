import { useForm } from '@tanstack/react-form';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { InferRequestType } from 'hono/client';
import { useEffect, useRef, useState } from 'react';

import {
  type Fastener,
  type FastenerColor,
  type MomentStatus,
  fastenerColorOptions,
  fastenerOptions,
  momentKeys,
  momentStatusLabels,
} from '@/entities/moment';
import { client } from '@/shared/api';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { Label } from '@/shared/ui/label';
import { Textarea } from '@/shared/ui/textarea';

import { compressImage } from '../lib/compress-image';
import { buildPreviewUrl } from '../lib/preview-url';
import { uploadImages } from '../lib/upload-image';
import { MOMENT_TEXT_MAX, momentFormSchema } from '../model/schema';

type CreateMomentInput = InferRequestType<typeof client.api.moments.$post>['json'];

const swatchClasses: Record<FastenerColor, string> = {
  pink: 'bg-pink-300',
  blue: 'bg-sky-300',
  yellow: 'bg-yellow-300',
  green: 'bg-green-300',
};

export function MomentForm() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [file, setFile] = useState<File | null>(null);
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [fastener, setFastener] = useState<Fastener>('clip');
  const [fastenerColor, setFastenerColor] = useState<FastenerColor | null>(null);
  const [status, setStatus] = useState<MomentStatus>('published');
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  // 同じファイルの圧縮 + アップロードは一度だけ行う (プレビュー → 投稿で再利用)
  const uploadedRef = useRef<{ file: File; imageKey: string } | null>(null);

  useEffect(() => {
    return () => {
      if (objectUrl !== null) URL.revokeObjectURL(objectUrl);
    };
  }, [objectUrl]);

  const selectFile = (next: File | null) => {
    setFile(next);
    setObjectUrl((prev) => {
      if (prev !== null) URL.revokeObjectURL(prev);
      return next !== null ? URL.createObjectURL(next) : null;
    });
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

  const form = useForm({
    defaultValues: { text: '' },
    onSubmit: async ({ value }) => {
      setSubmitError(null);
      if (file === null) {
        setSubmitError('写真を選択してください');
        return;
      }
      try {
        const imageKey = await ensureUploaded(file);
        await createMutation.mutateAsync({
          text: value.text.trim(),
          imageKey,
          fastener,
          ...(fastenerColor !== null ? { fastenerColor } : {}),
          status,
        });
      } catch (err) {
        setSubmitError(err instanceof Error ? err.message : '送信に失敗しました');
      }
    },
  });

  const handlePreview = async () => {
    setSubmitError(null);
    if (file === null) {
      setSubmitError('写真を選択してください');
      return;
    }
    setIsPreviewing(true);
    try {
      const imageKey = await ensureUploaded(file);
      const url = buildPreviewUrl({
        imageKey,
        text: form.state.values.text,
        fastener,
        fastenerColor,
      });
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'プレビューに失敗しました');
    } finally {
      setIsPreviewing(false);
    }
  };

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
        <Label htmlFor="moment-image">写真 (必須)</Label>
        <input
          id="moment-image"
          type="file"
          accept="image/*"
          className="text-sm"
          data-testid="moment-form-image"
          onChange={(e) => selectFile(e.target.files?.[0] ?? null)}
        />
        {objectUrl !== null && (
          <img
            src={objectUrl}
            alt="選択した写真のプレビュー"
            className="max-h-64 w-fit rounded-md border object-contain"
          />
        )}
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
          disabled={isPreviewing || createMutation.isPending}
          data-testid="moment-form-preview"
        >
          {isPreviewing ? 'アップロード中…' : 'プレビュー'}
        </Button>
        <Button
          type="submit"
          disabled={createMutation.isPending || isPreviewing}
          data-testid="moment-form-submit"
        >
          {createMutation.isPending ? '投稿中…' : status === 'draft' ? '下書き保存' : '投稿する'}
        </Button>
      </div>
    </form>
  );
}
