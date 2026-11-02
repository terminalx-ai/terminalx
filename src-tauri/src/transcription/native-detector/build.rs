fn main() {
    let include = std::env::var_os("DEP_TRANSCRIBE_CPP_INCLUDE_DIR")
        .expect("transcribe-cpp must expose its supported include_dir metadata");
    println!("cargo:rerun-if-changed=detector.cpp");
    println!("cargo:rerun-if-changed=detector.h");
    cc::Build::new()
        .cpp(true)
        .std("c++17")
        .warnings(true)
        .warnings_into_errors(true)
        .include(include)
        .file("detector.cpp")
        .compile("tx439_detector");
}
