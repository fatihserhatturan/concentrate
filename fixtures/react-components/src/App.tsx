import { Link } from 'react-router-dom';
import { Avatar, Card } from './components';
import { Input } from './components/Input';
import { Legacy } from './components/Legacy';

type User = { name: string; avatarUrl?: string };

function Profile({ user }: { user: User }) {
  return (
    <Card title={user.name}>
      {user.avatarUrl ? <Avatar url={user.avatarUrl} /> : null}
      <Link to="/settings">Settings</Link>
    </Card>
  );
}

// PascalCase but no JSX: not a component.
function FormatDate(date: Date): string {
  return date.toISOString();
}

// Returns JSX but is not PascalCase: a render helper, not a component.
function renderRow(user: User) {
  return <li key={user.name}>{user.name}</li>;
}

export default function App({ users }: { users: User[] }) {
  return (
    <main>
      <ul>{users.map(renderRow)}</ul>
      {users.map((user) => <Profile key={user.name} user={user} />)}
      <Input name="search" />
      <Legacy ready onGo={() => FormatDate(new Date())} />
    </main>
  );
}
