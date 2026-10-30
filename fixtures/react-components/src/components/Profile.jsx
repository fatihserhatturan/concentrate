import { connect } from 'react-redux';
import { withRouter } from 'react-router-dom';
import { Button } from './Button';

const mapStateToProps = (state) => ({ user: state.user });

// Exported through two higher-order components; `<Profile>` in another file
// renders ProfileView.
const ProfileView = ({ user }) => <Button label={user.name} />;

export default connect(mapStateToProps)(withRouter(ProfileView));
