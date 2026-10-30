import type { FC } from 'react';

const Avatar: FC<{ url: string }> = ({ url }) => <img className="avatar" src={url} />;

export default Avatar;
