pub trait Notifier {
    fn send(&self, message: &str);
}

pub struct Email;
pub struct Sms;

impl Notifier for Email {
    fn send(&self, message: &str) {
        let _ = message;
    }
}

impl Notifier for Sms {
    fn send(&self, message: &str) {
        let _ = message;
    }
}
