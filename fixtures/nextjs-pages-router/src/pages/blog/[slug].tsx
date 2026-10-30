import type { GetStaticProps } from 'next';

export const getStaticProps: GetStaticProps = async ({ params }) => ({ props: { slug: params?.slug } });

export default function BlogPost({ slug }: { slug: string }) {
  return <article>{slug}</article>;
}
