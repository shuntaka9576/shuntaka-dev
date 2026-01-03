import Image from 'next/image';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center p-8">
      <Image src="/assets/404.svg" alt="404" width={200} height={83} priority />
      <p className="mt-4 text-gray-600">
        このページはすでに削除されているか、URLが間違っている可能性があります。
      </p>
    </div>
  );
}
