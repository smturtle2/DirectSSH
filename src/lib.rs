mod backend;
mod model;
mod ssh;
mod terminal;
mod vault;

slint::include_modules!();

#[cfg(target_os = "android")]
#[unsafe(no_mangle)]
fn android_main(app: slint::android::AndroidApp) {
    let data_dir = app
        .internal_data_path()
        .unwrap_or_else(|| std::path::PathBuf::from("."));

    slint::android::init(app).expect("failed to initialize Slint Android backend");
    backend::run(data_dir).expect("failed to run DirectSSH");
}

pub fn run_desktop() -> Result<(), slint::PlatformError> {
    let data_dir = directories::ProjectDirs::from("dev", "DirectSSH", "DirectSSH")
        .map(|dirs| dirs.data_local_dir().to_path_buf())
        .unwrap_or_else(|| std::path::PathBuf::from(".directssh"));

    backend::run(data_dir)
}
