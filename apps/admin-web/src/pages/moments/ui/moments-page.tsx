import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import {
  type Moment,
  fastenerColorLabels,
  fastenerLabels,
  momentKeys,
  momentListInfiniteQuery,
  momentStatusLabels,
} from '@/entities/moment';
import { client } from '@/shared/api';
import { formatDateTime } from '@/shared/lib/utils';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { ButtonLink } from '@/shared/ui/button-link';
import { Skeleton } from '@/shared/ui/skeleton';

export function MomentsPage() {
  const queryClient = useQueryClient();
  const listQuery = useInfiniteQuery(momentListInfiniteQuery());

  const publishMutation = useMutation({
    mutationFn: async (momentId: string) => {
      const res = await client.api.moments[':id'].$patch({
        param: { id: momentId },
        json: { status: 'published' },
      });
      if (!res.ok) throw new Error('公開に失敗しました');
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: momentKeys.all });
    },
  });

  const unpublishMutation = useMutation({
    mutationFn: async (momentId: string) => {
      const res = await client.api.moments[':id'].$patch({
        param: { id: momentId },
        json: { status: 'draft' },
      });
      if (!res.ok) throw new Error('下書きに戻せませんでした');
      return res.json();
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: momentKeys.all });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (momentId: string) => {
      const res = await client.api.moments[':id'].$delete({ param: { id: momentId } });
      if (!res.ok) throw new Error('削除に失敗しました');
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: momentKeys.all });
    },
  });

  if (listQuery.isPending) {
    return (
      <div className="flex flex-col gap-3" data-testid="moments-loading">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (listQuery.isError) {
    return (
      <p className="text-sm text-destructive" data-testid="moments-error">
        {listQuery.error.message}
      </p>
    );
  }

  const moments = listQuery.data.pages.flatMap((page) => page.items);
  const mutationError = publishMutation.error ?? unpublishMutation.error ?? deleteMutation.error;

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-bold">moments</h1>
      {mutationError !== null && (
        <p className="text-sm text-destructive" data-testid="moments-action-error">
          {mutationError.message}
        </p>
      )}
      {moments.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="moments-empty">
          まだ投稿がありません
        </p>
      ) : (
        <ul className="flex flex-col gap-3" data-testid="moments-list">
          {moments.map((moment) => (
            <MomentRow
              key={moment.momentId}
              moment={moment}
              onPublish={() => publishMutation.mutate(moment.momentId)}
              onUnpublish={() => unpublishMutation.mutate(moment.momentId)}
              onDelete={() => {
                if (window.confirm('この投稿を削除しますか？')) {
                  deleteMutation.mutate(moment.momentId);
                }
              }}
              isMutating={
                (publishMutation.isPending && publishMutation.variables === moment.momentId) ||
                (unpublishMutation.isPending && unpublishMutation.variables === moment.momentId) ||
                (deleteMutation.isPending && deleteMutation.variables === moment.momentId)
              }
            />
          ))}
        </ul>
      )}
      {listQuery.hasNextPage && (
        <Button
          variant="outline"
          onClick={() => void listQuery.fetchNextPage()}
          disabled={listQuery.isFetchingNextPage}
          data-testid="moments-load-more"
        >
          {listQuery.isFetchingNextPage ? '読み込み中…' : 'もっと見る'}
        </Button>
      )}
    </div>
  );
}

function MomentRow({
  moment,
  onPublish,
  onUnpublish,
  onDelete,
  isMutating,
}: {
  moment: Moment;
  onPublish: () => void;
  onUnpublish: () => void;
  onDelete: () => void;
  isMutating: boolean;
}) {
  return (
    <li className="flex items-start gap-3 rounded-md border p-3" data-testid="moment-row">
      <img
        src={moment.thumbUrl}
        alt=""
        loading="lazy"
        className="size-16 shrink-0 rounded object-cover"
      />
      <div className="min-w-0 flex-1">
        <p className="line-clamp-2 text-sm">{moment.text}</p>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={moment.status === 'published' ? 'default' : 'secondary'}>
            {momentStatusLabels[moment.status]}
          </Badge>
          <span>
            {fastenerLabels[moment.fastener]}
            {moment.fastenerColor !== null && ` (${fastenerColorLabels[moment.fastenerColor]})`}
          </span>
          <span>
            {moment.status === 'published'
              ? formatDateTime(moment.publishedAt)
              : formatDateTime(moment.createdAt)}
          </span>
        </div>
      </div>
      <div className="flex shrink-0 flex-col gap-2">
        {moment.status === 'draft' ? (
          <Button size="xs" onClick={onPublish} disabled={isMutating} data-testid="moment-publish">
            公開する
          </Button>
        ) : (
          <Button
            size="xs"
            variant="outline"
            onClick={onUnpublish}
            disabled={isMutating}
            data-testid="moment-unpublish"
          >
            下書きに戻す
          </Button>
        )}
        <ButtonLink
          size="xs"
          variant="outline"
          to="/moments/$momentId/edit"
          params={{ momentId: moment.momentId }}
          data-testid="moment-edit"
        >
          編集
        </ButtonLink>
        <Button
          size="xs"
          variant="destructive"
          onClick={onDelete}
          disabled={isMutating}
          data-testid="moment-delete"
        >
          削除
        </Button>
      </div>
    </li>
  );
}
