import type { Metadata } from 'next';
import { MomentsView } from '@/components/MomentsView';
import { SITE_TITLE } from '@/lib/constants';

export const metadata: Metadata = {
  title: `moments | ${SITE_TITLE}`,
  alternates: {
    canonical: '/moments',
  },
};

export default function MomentsPage() {
  return <MomentsView />;
}
