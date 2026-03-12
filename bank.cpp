#include <vector>
#include <algorithm>
// -- SECTION: BANK_COMMAND -----------------------------------------------------
// bank.cpp — #included by reactor.cpp after sendToBot(), memoryGet(), memorySet()
void handleBank(const std::string& username, const std::string& args, const std::string& channel, const std::vector<std::string>& admins) {

    std::string _memPath = getMemoryPath();

    auto memGet = [&](const std::string& k) -> std::string { return memoryGet(k); };
    auto memSet = [&](const std::string& k, const std::string& v) { memorySet(k, v); };

    auto sendToChat = [&](const std::string& msg) {
        WSADATA wsa;
        WSAStartup(MAKEWORD(2,2), &wsa);
        SOCKET s = socket(AF_INET, SOCK_STREAM, 0);
        sockaddr_in a;
        a.sin_family = AF_INET;
        a.sin_port = htons(9001);
        a.sin_addr.s_addr = inet_addr("127.0.0.1");
        connect(s, (sockaddr*)&a, sizeof(a));
        send(s, msg.c_str(), msg.size(), 0);
        closesocket(s);
        WSACleanup();
    };

    auto getBank = [&](const std::string& user) -> long long {
        std::string val = memGet("bank_" + user);
        if (val.empty()) { memSet("bank_" + user, "500"); return 500; }
        return std::stoll(val);
    };
    auto setBank = [&](const std::string& user, long long amount) {
        memSet("bank_" + user, std::to_string(amount));
    };
    auto getCash = [&](const std::string& user) -> long long {
        std::string val = memGet("cash_" + user);
        if (val.empty()) { memSet("cash_" + user, "200"); return 200; }
        return std::stoll(val);
    };
    auto setCash = [&](const std::string& user, long long amount) {
        memSet("cash_" + user, std::to_string(amount));
    };
    auto isJailed = [&](const std::string& user) -> bool {
        std::string jailEnd = memGet("jail_" + user);
        if (jailEnd.empty()) return false;
        return std::stoll(jailEnd) > (long long)time(nullptr);
    };
    auto jailTimeLeft = [&](const std::string& user) -> long long {
        std::string jailEnd = memGet("jail_" + user);
        if (jailEnd.empty()) return 0;
        long long diff = std::stoll(jailEnd) - (long long)time(nullptr);
        return diff > 0 ? diff : 0;
    };
    auto getAllUsers = [&]() -> std::vector<std::string> {
        std::vector<std::string> users;
        std::ifstream f(_memPath);
        if (!f.is_open()) return users;
        std::string line;
        while (std::getline(f, line)) {
            std::string prefix = "\"bank_";
            size_t pos = line.find(prefix);
            if (pos != std::string::npos) {
                pos += prefix.size();
                size_t end = line.find("\"", pos);
                if (end != std::string::npos)
                    users.push_back(line.substr(pos, end - pos));
            }
        }
        f.close();
        return users;
    };

    // ---- PARSE ARGS ----
    std::string sub = "";
    std::string arg1 = "";
    std::string arg2 = "";
    std::istringstream argStream(args);
    argStream >> sub >> arg1 >> arg2;
    if (!arg1.empty() && arg1[0] == '@') arg1 = arg1.substr(1);

    // ---- JAIL CHECK ----
    if (sub != "leaderboard" && sub != "baltop" && sub != "balance" && sub != "bal" && sub != "admin") {
        if (isJailed(username)) {
            long long secs = jailTimeLeft(username);
            long long hrs = secs / 3600;
            long long mins = (secs % 3600) / 60;
            std::string t = hrs > 0 ? std::to_string(hrs) + "h " + std::to_string(mins) + "m" : std::to_string(mins) + "m";
            sendToChat("@" + username + " \xF0\x9F\x91\xAE Jail \xe2\x80\x94 locked up for " + t);
            return;
        }
    }

    // ---- BALANCE ----
    if (sub == "balance" || sub == "bal") {
        std::string target = arg1.empty() ? username : arg1;
        long long bank = getBank(target);
        long long cash = getCash(target);
        sendToChat("@" + target + " \xF0\x9F\x8F\xA6 $" + std::to_string(bank) + " | \xF0\x9F\x92\xB5 $" + std::to_string(cash));
    }

    // ---- DEPOSIT ----
    else if (sub == "deposit") {
        if (arg1.empty()) {
            sendToChat("@" + username + " you typed that wrong.");
        } else {
            long long amount = std::stoll(arg1);
            if (amount <= 0 || amount > 50) {
                sendToChat("@" + username + " you can only deposit between $1 and $50 per hour.");
            } else {
                std::string lastKey = "deposit_time_" + username;
                std::string lastStr = memGet(lastKey);
                long long now = (long long)time(nullptr);
                if (!lastStr.empty() && (now - std::stoll(lastStr)) < 3600) {
                    long long wait = 3600 - (now - std::stoll(lastStr));
                    sendToChat("@" + username + " deposit again in " + std::to_string(wait / 60) + " minutes.");
                } else {
                    long long cash = getCash(username);
                    if (amount > cash) {
                        sendToChat("@" + username + " only have \xF0\x9F\x92\xB5 $" + std::to_string(cash));
                    } else {
                        long long bank = getBank(username);
                        setCash(username, cash - amount);
                        setBank(username, bank + amount);
                        memSet(lastKey, std::to_string(now));
                        sendToChat("@" + username + " deposited $" + std::to_string(amount) + " \xF0\x9F\x8F\xA6 $" + std::to_string(bank + amount) + " | \xF0\x9F\x92\xB5 $" + std::to_string(cash - amount));
                    }
                }
            }
        }
    }

    // ---- WITHDRAW ----
    else if (sub == "withdraw") {
        if (arg1.empty()) {
            sendToChat("@" + username + " you typed that wrong.");
        } else {
            long long amount = std::stoll(arg1);
            long long bank = getBank(username);
            if (amount <= 0) {
                sendToChat("@" + username + " you typed that wrong.");
            } else if (amount > bank) {
                sendToChat("@" + username + " \xF0\x9F\x8F\xA6 only has $" + std::to_string(bank));
            } else {
                long long cash = getCash(username);
                setBank(username, bank - amount);
                setCash(username, cash + amount);
                sendToChat("@" + username + " withdrew $" + std::to_string(amount) + " \xF0\x9F\x8F\xA6 $" + std::to_string(bank - amount) + " | \xF0\x9F\x92\xB5 $" + std::to_string(cash + amount));
            }
        }
    }

    // ---- GIVE ----
    else if (sub == "give") {
        if (arg1.empty() || arg2.empty()) {
            sendToChat("@" + username + " you typed that wrong.");
        } else {
            long long amount = std::stoll(arg2);
            long long myBank = getBank(username);
            if (amount <= 0) {
                sendToChat("@" + username + " you typed that wrong.");
            } else if (amount > myBank) {
                sendToChat("@" + username + " \xF0\x9F\x8F\xA6 only has $" + std::to_string(myBank));
            } else {
                long long theirBank = getBank(arg1);
                setBank(username, myBank - amount);
                setBank(arg1, theirBank + amount);
                sendToChat("@" + username + " sent \xF0\x9F\x8F\xA6 $" + std::to_string(amount) + " to @" + arg1);
            }
        }
    }

    // ---- DAILY ----
    else if (sub == "daily") {
        std::string lastKey = "daily_" + username;
        std::string lastStr = memGet(lastKey);
        long long now = (long long)time(nullptr);
        if (!lastStr.empty() && (now - std::stoll(lastStr)) < 86400) {
            long long wait = 86400 - (now - std::stoll(lastStr));
            long long hrs = wait / 3600;
            long long mins = (wait % 3600) / 60;
            sendToChat("@" + username + " \xF0\x9F\x8E\x81 come back in " + std::to_string(hrs) + "h " + std::to_string(mins) + "m");
        } else {
            long long bonus = 200;
            long long cash = getCash(username);
            setCash(username, cash + bonus);
            memSet(lastKey, std::to_string(now));
            sendToChat("@" + username + " \xF0\x9F\x8E\x81 +$" + std::to_string(bonus) + " \xF0\x9F\x92\xB5 $" + std::to_string(cash + bonus));
        }
    }

    // ---- ROB ----
    else if (sub == "rob") {
        std::string coolKey = "rob_cooldown_" + username;
        std::string coolStr = memGet(coolKey);
        long long now = (long long)time(nullptr);
        if (!coolStr.empty() && (now - std::stoll(coolStr)) < 300) {
            long long wait = 300 - (now - std::stoll(coolStr));
            sendToChat("@" + username + " \xF0\x9F\xA6\x9D Rob \xe2\x80\x94 wait " + std::to_string(wait / 60 + 1) + " more minutes.");
        } else {
            long long myCash = getCash(username);
            std::string target = arg1;
            if (target.empty()) {
                std::vector<std::string> users = getAllUsers();
                users.erase(std::remove(users.begin(), users.end(), username), users.end());
                if (users.empty()) { sendToChat("@" + username + " nobody to rob!"); return; }
                srand((unsigned int)time(nullptr));
                target = users[rand() % users.size()];
            }
            long long theirCash = getCash(target);
            if (theirCash <= 0) {
                sendToChat("@" + username + " @" + target + " has no \xF0\x9F\x92\xB5 on them.");
            } else {
                long long amount = 0;
                if (!arg2.empty()) { amount = std::stoll(arg2); }
                else { amount = myCash / 10; if (amount < 1) amount = 1; }
                if (amount > theirCash) amount = theirCash;
                srand((unsigned int)time(nullptr));
                bool success = (rand() % 2) == 0;
                memSet(coolKey, std::to_string(now));
                if (success) {
                    setCash(username, myCash + amount);
                    setCash(target, theirCash - amount);
                    sendToChat("@" + username + " \xF0\x9F\xA6\x9D Rob \xe2\x80\x94 stole \xF0\x9F\x92\xB5 $" + std::to_string(amount) + " from @" + target + "! \xF0\x9F\x92\xB5 $" + std::to_string(myCash + amount));
                } else {
                    double ratio = myCash > 0 ? (double)amount / (double)myCash : 8.0;
                    long long jailHours = (long long)(ratio * 2.0);
                    if (jailHours < 1) jailHours = 1;
                    if (jailHours > 8) jailHours = 8;
                    memSet("jail_" + username, std::to_string(now + jailHours * 3600));
                    sendToChat("@" + username + " \xF0\x9F\xA6\x9D Rob \xe2\x80\x94 caught stealing from @" + target + "! \xF0\x9F\x91\xAE Jail: " + std::to_string(jailHours) + "h");
                }
            }
        }
    }

    // ---- LEADERBOARD ----
    else if (sub == "leaderboard" || sub == "baltop") {
        std::vector<std::string> users = getAllUsers();
        if (users.empty()) {
            sendToChat("No users yet!");
        } else {
            std::vector<std::pair<long long, std::string>> ranked;
            for (auto& u : users) {
                std::string bval = memGet("bank_" + u);
                std::string cval = memGet("cash_" + u);
                long long total = 0;
                if (!bval.empty()) total += std::stoll(bval);
                if (!cval.empty()) total += std::stoll(cval);
                ranked.push_back({total, u});
            }
            std::sort(ranked.begin(), ranked.end(), [](const std::pair<long long,std::string>& a, const std::pair<long long,std::string>& b) {
                return a.first > b.first;
            });
            std::string board = "\xF0\x9F\x8F\x86 ";
            int count = 0;
            for (auto& r : ranked) {
                if (count >= 5) break;
                board += std::to_string(count + 1) + ". @" + r.second + " $" + std::to_string(r.first) + " ";
                count++;
            }
            sendToChat(board);
        }
    }

    // ---- UNJAIL (admin) ----
    else if (sub == "unjail") {
        std::string userLower = username;
        std::transform(userLower.begin(), userLower.end(), userLower.begin(), ::tolower);
        bool isAdmin = std::find(admins.begin(), admins.end(), userLower) != admins.end();
        if (!isAdmin) { sendToChat("@" + username + " no permission."); return; }
        std::string target = arg1;
        if (target.empty()) { sendToChat("@" + username + " you typed that wrong."); return; }
        if (target[0] == '@') target = target.substr(1);
        memSet("jail_" + target, "0");
        sendToChat("@" + target + " \xF0\x9F\x91\xAE released!");
    }

    // ---- RESETCOOLDOWN (admin) ----
    else if (sub == "resetcooldown") {
        std::string userLower = username;
        std::transform(userLower.begin(), userLower.end(), userLower.begin(), ::tolower);
        bool isAdmin = std::find(admins.begin(), admins.end(), userLower) != admins.end();
        if (!isAdmin) { sendToChat("@" + username + " no permission."); return; }
        std::string target = arg1;
        if (target.empty()) { sendToChat("@" + username + " you typed that wrong."); return; }
        if (target[0] == '@') target = target.substr(1);
        memSet("rob_cooldown_" + target, "0");
        memSet("deposit_time_" + target, "0");
        memSet("daily_" + target, "0");
        sendToChat("@" + target + " cooldowns reset!");
    }

    // ---- SETBANK (admin) ----
    else if (sub == "setbank") {
        bool isAdmin = std::find(admins.begin(), admins.end(), username) != admins.end();
        if (!isAdmin) { sendToChat("@" + username + " no permission."); return; }
        if (arg1.empty() || arg2.empty()) { sendToChat("@" + username + " you typed that wrong."); return; }
        std::string target = arg1;
        if (target[0] == '@') target = target.substr(1);
        setBank(target, std::stoll(arg2));
        sendToChat("@" + target + " \xF0\x9F\x8F\xA6 $" + arg2);
    }

    // ---- SETCASH (admin) ----
    else if (sub == "setcash") {
        bool isAdmin = std::find(admins.begin(), admins.end(), username) != admins.end();
        if (!isAdmin) { sendToChat("@" + username + " no permission."); return; }
        if (arg1.empty() || arg2.empty()) { sendToChat("@" + username + " you typed that wrong."); return; }
        std::string target = arg1;
        if (target[0] == '@') target = target.substr(1);
        setCash(target, std::stoll(arg2));
        sendToChat("@" + target + " \xF0\x9F\x92\xB5 $" + arg2);
    }

    // ---- UNKNOWN SUBCOMMAND ----
    else if (!sub.empty()) {
        sendToChat("@" + username + " you typed that wrong.");
    }

    // ---- BARE !bank — show menu ----
    else {
        sendToChat("@" + username + " \xF0\x9F\x8F\xA6 balance | deposit | withdraw | give @user | \xF0\x9F\x8E\x81 daily | \xF0\x9F\xA6\x9D rob | \xF0\x9F\x8F\x86 leaderboard");
    }
}